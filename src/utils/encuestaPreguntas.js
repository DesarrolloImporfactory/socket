/**
 * encuestaPreguntas.js
 *
 * Schema y validación de las preguntas configurables de una encuesta.
 * Las preguntas se guardan como JSON en la columna `encuestas.preguntas`
 * y las renderiza el formulario público (EncuestaPublica.jsx).
 *
 * Forma de una pregunta:
 *   {
 *     key:         'presupuesto_importacion',   // identificador estable
 *     label:       '¿Cuál es tu presupuesto?',  // lo que ve el cliente
 *     type:        'radio',                     // ver TIPOS_PREGUNTA
 *     required:    true,
 *     placeholder: 'Tu respuesta...',           // solo text/textarea/number
 *     hint:        'Texto de ayuda opcional',
 *     options:     ['Menos de $1.000', ...]     // solo radio/checkbox/select
 *   }
 */

const TIPOS_PREGUNTA = [
  'text',
  'textarea',
  'radio',
  'checkbox',
  'select',
  'rating_1_5',
  'number',
];

// Tipos que necesitan una lista de opciones para tener sentido
const TIPOS_CON_OPCIONES = ['radio', 'checkbox', 'select'];

const MAX_PREGUNTAS = 30;
const MAX_OPCIONES = 20;
const MAX_LABEL = 300;
const MAX_OPCION = 200;

/**
 * Convierte un label en una key estable: sin tildes, sin símbolos, snake_case.
 * "¿Cuál es tu presupuesto?" → "cual_es_tu_presupuesto"
 */
function slugifyKey(texto, fallback = 'pregunta') {
  const base = String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

  return base || fallback;
}

/**
 * Normaliza y valida el array de preguntas que llega del front.
 * Nunca lanza: descarta lo inválido y devuelve siempre un array limpio.
 * Garantiza keys únicas (si se repiten, agrega sufijo _2, _3...).
 */
function normalizarPreguntas(raw) {
  let lista = raw;

  if (typeof lista === 'string') {
    try {
      lista = JSON.parse(lista);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(lista)) return [];

  const usadas = new Set();
  const preguntas = [];

  for (const item of lista.slice(0, MAX_PREGUNTAS)) {
    if (!item || typeof item !== 'object') continue;

    const label = String(item.label ?? '')
      .trim()
      .slice(0, MAX_LABEL);
    if (!label) continue; // una pregunta sin enunciado no sirve

    const type = TIPOS_PREGUNTA.includes(item.type) ? item.type : 'text';

    // Key: la que venga, o derivada del label. Desduplicar siempre.
    let key = slugifyKey(item.key || label, `pregunta_${preguntas.length + 1}`);
    if (usadas.has(key)) {
      let n = 2;
      while (usadas.has(`${key}_${n}`)) n++;
      key = `${key}_${n}`;
    }
    usadas.add(key);

    const pregunta = {
      key,
      label,
      type,
      required: item.required === true || item.required === 1,
    };

    const placeholder = String(item.placeholder ?? '').trim();
    if (placeholder) pregunta.placeholder = placeholder.slice(0, MAX_LABEL);

    const hint = String(item.hint ?? '').trim();
    if (hint) pregunta.hint = hint.slice(0, MAX_LABEL);

    if (TIPOS_CON_OPCIONES.includes(type)) {
      const options = Array.isArray(item.options)
        ? item.options
            .map((o) => String(o ?? '').trim())
            .filter(Boolean)
            .slice(0, MAX_OPCIONES)
            .map((o) => o.slice(0, MAX_OPCION))
        : [];

      // Un radio/select/checkbox sin opciones no se puede responder:
      // degradarlo a texto libre es mejor que romper el formulario.
      if (options.length === 0) {
        pregunta.type = 'text';
      } else {
        pregunta.options = [...new Set(options)];
      }
    }

    preguntas.push(pregunta);
  }

  return preguntas;
}

/**
 * Valida las respuestas del cliente contra las preguntas obligatorias.
 * Devuelve un array de labels sin responder (vacío = todo OK).
 */
function validarRespuestasRequeridas(preguntas, respuestas) {
  const lista = normalizarPreguntas(preguntas);
  const data = respuestas && typeof respuestas === 'object' ? respuestas : {};
  const faltantes = [];

  for (const p of lista) {
    if (!p.required) continue;

    const valor = data[p.key];
    const vacio =
      valor === undefined ||
      valor === null ||
      (typeof valor === 'string' && !valor.trim()) ||
      (Array.isArray(valor) && valor.length === 0);

    if (vacio) faltantes.push(p.label);
  }

  return faltantes;
}

module.exports = {
  TIPOS_PREGUNTA,
  TIPOS_CON_OPCIONES,
  MAX_PREGUNTAS,
  slugifyKey,
  normalizarPreguntas,
  validarRespuestasRequeridas,
};
