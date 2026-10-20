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
- No AFIRMES ni NIEGUES lo que no esté en la información que te dieron. "No
  tenemos ese color" es tan inventado como "sí lo tenemos", y encima espanta
  al cliente. Si no lo sabes, dices que lo confirmas por el privado.
- Si preguntan por otro producto que no es el de esta publicación, NO SABES si
  el negocio lo vende. No digas que sí ni que no —"no lo tenemos" puede ser
  falso y pierde una venta—: di que le escribes al privado y ahí se lo
  confirman.
- No pidas datos personales en público (teléfono, dirección, cédula, correo).
  Eso se pide en el privado, nunca en un comentario que ve todo el mundo.
- No prometas nada que no esté en la información que recibiste.
- No expliques lo que hiciste ni adornes con comillas o prefijos del tipo
  "Aquí tienes una opción:". Solo lo que se le dice al cliente.
`.trim();

/**
 * El formato de salida, y con él la promesa del privado.
 *
 * POR QUÉ DOS BLOQUES EN UNA SOLA LLAMADA
 *
 * El modelo ya decidió, al redactar el comentario, si hacía falta seguir en
 * privado: lo dice ahí mismo ("te escribo al privado"). Pedirle el privado en
 * otra llamada sería preguntarle dos veces lo mismo, pagar dos veces y
 * arriesgar que la segunda contradiga a la primera.
 *
 * Y resuelve algo que estaba roto: hasta ahora "te escribo al privado" era una
 * promesa que no cumplía nadie si el agente no hacía clic. Si el comentario la
 * hace, el privado sale junto con él.
 *
 * Va aparte de REGLAS_DEL_SISTEMA porque eso se le muestra al negocio en la
 * pantalla del asistente, y el formato no es una decisión suya: es el contrato
 * con el código que lee la respuesta.
 */
const FORMATO_SALIDA = `
FORMATO DE LA RESPUESTA. Exactamente estas dos líneas y nada más:
RESPUESTA: <lo que TÚ publicas en el comentario, a la vista de todos>
PRIVADO: <el primer mensaje del chat privado, o la palabra NO>

No copies el comentario del cliente en RESPUESTA: ahí va lo que le contestas.

Cuándo lleva PRIVADO:
- Si en la RESPUESTA dices que le escribes al privado, entonces PRIVADO es
  OBLIGATORIO: ese es el mensaje que vas a mandar. Prometerlo y poner NO deja
  al negocio quedando mal en público.
- Si la respuesta pública ya quedó completa y no hay nada que cerrar, PRIVADO: NO
- Ante un elogio, una etiqueta a un amigo o un emoji, PRIVADO: NO

Cómo se escribe el PRIVADO:
- Es el PRIMER mensaje de una conversación de venta, no un aviso. Retoma lo que
  preguntó y respóndele lo que no se podía decir en el comentario. No repitas
  palabra por palabra lo que acabas de poner en la RESPUESTA pública.
- Máximo 3 frases. Nada de "hola, te escribo por acá": Facebook permite UN
  solo mensaje privado por comentario y no se gasta en un saludo vacío.
- Ahí sí puedes pedirle lo que en público no (su ciudad, por ejemplo).
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
  return `${base}\n\n${REGLAS_DEL_SISTEMA}\n\n${FORMATO_SALIDA}`;
}

/* Etiquetas de los dos bloques. Se aceptan con y sin tilde, en cualquier caja
   y con o sin negritas de markdown: cuando el modelo falla el formato, falla
   en el adorno, no en la palabra.

   La pública se pide como RESPUESTA y no como COMENTARIO, aunque "comentario"
   sea la palabra obvia. Con COMENTARIO el modelo entendía "el comentario del
   cliente" —la entrada dice literalmente "Comentario de un cliente: …"— y lo
   devolvía copiado tal cual, dejando la contestación en el privado. Se siguen
   aceptando los dos nombres por si alguna vez vuelve al viejo. */
const RE_BLOQUE =
  /^\s*\**\s*(RESPUESTA|COMENTARIO|P[UÚ]BLICO|PRIVADO|MENSAJE\s+PRIVADO)\s*\**\s*:\s*\**/i;

/* ¿La respuesta pública promete escribir al privado?
   Sólo las formas en las que NOSOTROS escribimos. "Escríbeme por privado" no
   cuenta: ahí la pelota la tiene el cliente y no hay nada que cumplir.

   El hueco del medio es porque entre el verbo y el destino cabe cualquier
   cosa: "te confirmo eso por el privado", "te paso el detalle al DM". Se corta
   en el signo de puntuación para no cruzar de una frase a la siguiente. */
const RE_PROMESA =
  /\b(te|le|puedo|podemos|voy\s+a|vamos\s+a|paso|escribo|mando|env[ií]o|confirmo|reviso|respondo|aclaro|detallo)\b[^.!?¡¿\n]{0,45}?\b(por|al|en)\s+(el\s+)?(privado|priv|dm|interno|mensaje\s+directo|mensaje\s+interno)\b/i;

/**
 * Si la respuesta pública promete un privado, ese privado hay que mandarlo.
 *
 * Es determinista a propósito y no se le pregunta al modelo: el modelo ya
 * mostró que propone privado también cuando la respuesta pública quedó
 * completa ("hacemos envío a Cuenca" + "cuéntame si necesitas más detalles"),
 * y Facebook permite UN solo privado por comentario. Gastarlo en un relleno
 * deja al agente sin el que sí hacía falta.
 *
 * Con esto la bandeja puede marcar el privado por defecto cuando se prometió,
 * y dejarlo desmarcado —pero a la vista— cuando es de cortesía.
 */
function prometePrivado(textoPublico) {
  return RE_PROMESA.test(String(textoPublico || ''));
}

/** Un PRIVADO que en realidad dice "no hace falta". */
const SIN_PRIVADO = /^(no|ninguno|nada|n\/a|-+|\(?\s*no\s+(hace\s+falta|aplica)\s*\)?)\.?$/i;

/**
 * Separa la salida del modelo en comentario público y mensaje privado.
 *
 * Es tolerante a propósito. Si el modelo se salta las etiquetas, lo que
 * devolvió se toma como el comentario y no hay privado: el agente ve un
 * borrador normal, que es el comportamiento de siempre.
 *
 * Lo que NO puede pasar nunca es publicar un texto con "PRIVADO:" dentro, ni
 * mandar al privado algo que el modelo no marcó como tal. De ahí que el corte
 * sea por etiqueta y no por heurística.
 */
function partirSalida(bruto) {
  const partes = { comentario: [], privado: [] };
  let actual = null;

  for (const linea of String(bruto || '').split(/\r?\n/)) {
    const m = linea.match(RE_BLOQUE);
    if (m) {
      actual = /PRIVADO/i.test(m[1]) ? 'privado' : 'comentario';
      partes[actual].push(linea.slice(m[0].length));
      continue;
    }
    // Lo que venga antes de cualquier etiqueta es el comentario.
    partes[actual || 'comentario'].push(linea);
  }

  const limpiar = (a) => a.join('\n').trim().replace(/\n{3,}/g, '\n\n');

  const comentario = limpiar(partes.comentario);
  let privado = limpiar(partes.privado);
  if (!privado || SIN_PRIVADO.test(privado)) privado = null;

  return { comentario, privado };
}

module.exports = {
  REGLAS_DEL_SISTEMA,
  FORMATO_SALIDA,
  partirSalida,
  prometePrivado,
  OPCIONES_POR_DEFECTO,
  normalizarOpciones,
  componerPrompt,
  promptFinal,
};
