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
//
// Pendiente de voltear antes del 2026-08-26, que es cuando OpenAI apaga la
// Assistants API. Para volver atrás después de voltearlo: false otra vez — el
// camino viejo sigue completo hasta esa fecha, y a partir de ahí ya no sirve.
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

// ─────────────────────────────────────────────────────────────
// CONFIGS_SIN_RECAP
//
// Cuentas que NO reciben la siembra de contexto: arrancan en blanco aunque el
// cliente tenga historial en mensajes_clientes.
//
// Normalmente la siembra es lo que se quiere —es el puente que evita que el bot
// salude de nuevo y vuelva a pedir datos ya dados al migrar de Assistants a
// Responses—, pero hay cuentas donde ese historial es ruido y meterlo empeora
// la respuesta:
//
//   818 "Imporfactory Grupos - API" — cuenta demo (5 clientes, 343 mensajes,
//        creada el 2026-07-20). Su historial es de pruebas con prompts que ya
//        no existen; sembrarlo le enseña al bot conversaciones que no
//        representan cómo debe atender hoy.
//
// Para agregar otra: el número acá y listo. Para revertir: sacarlo, y la
// siembra vuelve en el mensaje siguiente.
//
// ⚠️ ALCANCE: esto apaga SOLO la siembra de arranque (cuando no hay cadena
// previa). NO apaga el recap del reintento por context_length_exceeded en
// kanban_ia.service.js, y es a propósito: ahí la alternativa no es "arrancar
// limpio" sino que el bot se quede sin nada A MITAD de una conversación viva
// —pierde el producto, el nombre y la dirección— justo cuando el cliente lleva
// diez turnos hablando. Son dos problemas distintos aunque usen la misma
// función. Si alguna vez hace falta apagar también ese, es otra lista.
// ─────────────────────────────────────────────────────────────
const CONFIGS_SIN_RECAP = [818];

function usaRecapConversacion(id_configuracion) {
  return !CONFIGS_SIN_RECAP.includes(Number(id_configuracion));
}

module.exports = {
  TODAS,
  CONFIGS_CON_RESPONSES_API,
  usaResponsesApi,
  CONFIGS_SIN_RECAP,
  usaRecapConversacion,
};
