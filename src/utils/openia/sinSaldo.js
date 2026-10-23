// ════════════════════════════════════════════════════════════
// sinSaldo.js
// Detectar que la cuenta de OpenAI del cliente se quedó sin saldo.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El aviso de "sin saldo" llevaba meses sin dispararse: el 2026-08-13 había 32
// cuentas fallando por falta de crédito y solo UNA marcada, con fecha del 21 de
// julio. La lógica estaba copiada en cuatro sitios y las copias se separaron.
// Eran dos fallos distintos:
//
//   1) El detector leía el mensaje SOLO de err.response.data.error.message.
//      Cuando falla un *run* de la Assistants API la petición HTTP devuelve
//      200: el motivo viaja dentro de statusRes.data.last_error y el código lo
//      relanza como `new Error('Run falló: {...}')`. Ese error no tiene
//      .response, así que el mensaje quedaba en '' y no coincidía con nada.
//      Por eso el chat NUNCA marcó a nadie; los 5 avisos que existían los había
//      puesto el cron de remarketing, que sí caía a err.message.
//
//   2) OpenAI cambió el texto. Con el saldo prepago actual, quedarse sin
//      crédito llega como:
//        {"code":"rate_limit_exceeded","message":"You have no credits remaining..."}
//      Ni "insufficient_quota" ni "exceeded your current quota" aparecen, así
//      que también dejó de detectarlo el cron. De ahí que el último aviso sea
//      del 3 de agosto.
//
// OJO CON EL CÓDIGO rate_limit_exceeded
//
// NO se puede detectar por ese código: es el mismo que devuelve un límite de
// velocidad legítimo ("Rate limit reached for gpt-4o-mini ... tokens per min"),
// que es transitorio y se resuelve solo. Marcar esas cuentas como inactivas
// apagaría bots que funcionan perfectamente y que solo iban rápido. Por eso el
// reconocimiento va SIEMPRE por el texto del mensaje, nunca por ese código.
// ════════════════════════════════════════════════════════════

// Frases que solo aparecen cuando de verdad no hay con qué pagar.
// Deliberadamente NO se incluye 'quota' a secas ni 'rate limit'.
const FRASES_SIN_SALDO = [
  'no credits remaining', // saldo prepago agotado (el texto actual)
  'exceeded your current quota', // texto clásico de cuota agotada
  'insufficient_quota', // el code, por si viaja dentro del texto
  'billing_hard_limit_reached', // tope de facturación configurado por el cliente
  'check your plan and billing', // cola del mensaje clásico
];

// Saca el texto del error mirando los DOS sitios donde puede venir: el cuerpo
// de una respuesta HTTP de error, y el message de un Error lanzado a mano (que
// es donde queda el JSON de un run fallido).
function mensajeErrorOpenAI(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.message ||
    ''
  );
}

function esSinSaldoOpenAI(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const texto = mensajeErrorOpenAI(err).toLowerCase();

  // 402 Payment Required y el 429 con insufficient_quota son inequívocos.
  if (status === 402) return true;
  if (status === 429 && code === 'insufficient_quota') return true;

  return FRASES_SIN_SALDO.some((f) => texto.includes(f));
}

// Un límite de velocidad de verdad: mismo código que el de arriba, pero SIN
// ninguna frase de saldo. Es transitorio — reintentar, nunca marcar inactivo.
function esRateLimitTransitorio(err) {
  if (esSinSaldoOpenAI(err)) return false;
  const code = err?.response?.data?.error?.code;
  const texto = mensajeErrorOpenAI(err).toLowerCase();
  return (
    code === 'rate_limit_exceeded' ||
    texto.includes('rate_limit_exceeded') ||
    texto.includes('rate limit reached')
  );
}

// Clave inválida o revocada. No es lo mismo que quedarse sin saldo: el cliente
// tiene que volver a pegar la key, no recargar. Se distingue para que el aviso
// diga lo que hay que hacer.
function esApiKeyInvalida(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const texto = mensajeErrorOpenAI(err).toLowerCase();
  if (code === 'invalid_api_key') return true;
  if (texto.includes('invalid_api_key')) return true;
  if (texto.includes('incorrect api key provided')) return true;
  return status === 401;
}

// La organización de OpenAI del cliente no pasó la verificación de identidad
// que OpenAI exige para la familia gpt-5. Llega como 404 model_not_found con
// "Your organization must be verified to use the model `gpt-5-mini`" (cfg 1478,
// 2026-10-22: el bot se quedaba mudo en toda columna con gpt-5-mini y el
// cliente lo "arregló" bajando el modelo). No es saldo ni llave: la llave
// funciona con gpt-4.1-mini. El arreglo es que el dueño verifique la
// organización en platform.openai.com/settings/organization/general (tarda
// hasta 15 min en propagar); mientras tanto se responde con un modelo de
// respaldo (ver ejecutarConResponsesAPI en kanban_ia.service).
function esOrganizacionNoVerificada(err) {
  const texto = mensajeErrorOpenAI(err).toLowerCase();
  return texto.includes('must be verified');
}

// El modelo de la columna no existe o la cuenta no tiene acceso a él (404
// model_not_found: "The model `gpt-4o-xyz` does not exist or you do not have
// access to it"; también el 400 de un id mal escrito). NO es la verificación
// de organización (esa tiene su propio respaldo): acá el bot se queda mudo
// en esa columna hasta que el dueño cambie el modelo, y hay que decírselo.
function esModeloNoDisponible(err) {
  if (esOrganizacionNoVerificada(err)) return false;
  const code = err?.response?.data?.error?.code;
  const texto = mensajeErrorOpenAI(err).toLowerCase();
  if (code === 'model_not_found') return true;
  if (texto.includes('model_not_found')) return true;
  if (texto.includes('does not exist or you do not have access')) return true;
  return texto.includes('invalid model');
}

/* Por qué está apagada la IA de una cuenta (openai_activo=0), a partir del
   texto guardado en configuraciones.openai_error_msg. La vista de conexiones
   y la ventana al entrar necesitan el motivo, no solo el 0: "sin saldo" se
   arregla recargando; una llave inválida, cargando otra (cfg 1325, ZivaShop,
   2026-10-23: la llave llevaba el día revocada, el chat se llenaba de
   carteles y /conexiones decía "Servicios al día"). Se deduce del texto para
   no sumar una columna: los textos los escribimos nosotros (motor, cron de
   remarketing, rama de Claude) o son los de OpenAI que ya reconocen los
   detectores de arriba. */
const CODIGO_SIN_SALDO = 'SIN_SALDO';
const CODIGO_KEY_INVALIDA = 'KEY_INVALIDA';
const CODIGO_ERROR = 'ERROR';

function codigoErrorIA(msg) {
  const texto = String(msg || '').toLowerCase();
  // Marcas viejas sin texto: hasta hoy solo se marcaba por saldo.
  if (!texto) return CODIGO_SIN_SALDO;
  if (
    texto.includes('api key inválida') ||
    texto.includes('api key invalida') ||
    esApiKeyInvalida({ message: texto })
  ) {
    return CODIGO_KEY_INVALIDA;
  }
  if (texto.includes('sin saldo') || esSinSaldoOpenAI({ message: texto })) {
    return CODIGO_SIN_SALDO;
  }
  return CODIGO_ERROR;
}

// Con qué modelo se responde cuando gpt-5* está bloqueado por verificación.
// gpt-4.1-mini y no gpt-4o-mini: mismo rango de precio, modelo más nuevo y es
// el que el propio cliente comprobó que le funciona. En código y no en .env a
// propósito: se cambia aquí con un commit.
const MODELO_RESPALDO_GPT5 = 'gpt-4.1-mini';

const URL_VERIFICAR_ORGANIZACION =
  'https://platform.openai.com/settings/organization/general';

module.exports = {
  esSinSaldoOpenAI,
  esRateLimitTransitorio,
  esApiKeyInvalida,
  esOrganizacionNoVerificada,
  esModeloNoDisponible,
  codigoErrorIA,
  CODIGO_SIN_SALDO,
  CODIGO_KEY_INVALIDA,
  CODIGO_ERROR,
  MODELO_RESPALDO_GPT5,
  URL_VERIFICAR_ORGANIZACION,
  mensajeErrorOpenAI,
  FRASES_SIN_SALDO,
};
