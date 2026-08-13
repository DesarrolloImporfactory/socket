// ════════════════════════════════════════════════════════════
// responsesApi.js
// El interruptor único: qué cuentas corren por la Responses API.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// OpenAI apaga la Assistants API el 2026-08-26. Hay que mover las 273
// configuraciones sí o sí, y el interruptor estaba escrito a mano —
// `[10].includes(Number(id_configuracion))` — en NUEVE sitios repartidos por
// cuatro archivos. Migrar así es cambiar nueve líneas sin equivocarse en
// ninguna, y volver atrás en una emergencia también. Ahora se cambia acá.
//
// LAS DOS APIs NO SON INTERCAMBIABLES
//
// Lo que cambia al voltear esto, cuenta por cuenta:
//
//   prompt      Assistants lo lee del assistant en OpenAI; Responses de
//               kanban_columnas.instrucciones. Por eso hubo que sincronizar
//               las dos copias ANTES (ver scripts/sincronizarPromptsDesdeOpenai.js):
//               si difieren, el bot cambia de comportamiento en silencio.
//   contexto    Assistants encadena por thread; Responses por
//               previous_response_id. Al migrar, el hilo viejo no se hereda:
//               arranca en null y kanban_ia.service.js lo siembra con un recap
//               de la conversación sacado de nuestra BD.
//   vector      Assistants admite UN solo vector store por asistente;
//               Responses admite dos, así que catálogo y documentos pueden ir
//               por separado.
//   assistant   Por Responses el assistant_id deja de hacer falta. Las columnas
//               nuevas se crean con un id local_… y sin objeto en OpenAI.
//
// CÓMO SE MIGRA
//
// Se pone TODAS = true y se despliega. Para volver atrás, TODAS = false: la
// lista de abajo vuelve a mandar y las cuentas regresan al camino viejo — que
// seguirá existiendo hasta que OpenAI lo apague.
// ════════════════════════════════════════════════════════════

// Interruptor general de la migración.
//
// Mientras esté en false solo migran las configs de la lista. En true, TODAS,
// y la lista pasa a ser historia de por dónde empezó.
const TODAS = false;

// Configuraciones migradas a mano, en orden de llegada. Misma convención que
// CONFIGS_CON_CATALOGO_INLINE y CONFIGS_CON_TOPE en fileSearch.js: lista
// escrita a mano para ver de un vistazo hasta dónde llegó la migración.
//
//   10  — primera y única durante toda la fase de pruebas.
const CONFIGS_CON_RESPONSES_API = [10];

function usaResponsesApi(id_configuracion) {
  if (TODAS) return true;
  return CONFIGS_CON_RESPONSES_API.includes(Number(id_configuracion));
}

module.exports = {
  TODAS,
  CONFIGS_CON_RESPONSES_API,
  usaResponsesApi,
};
