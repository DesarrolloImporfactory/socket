// ════════════════════════════════════════════════════════════
// fileSearch.js
// Configuración compartida de la herramienta file_search.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// file_search trocea el catálogo en fragmentos de ~800 tokens y, por defecto,
// devuelve hasta 20 en CADA llamada. Medido en la config 10: 16.230 tokens de
// fragmentos por mensaje, para un catálogo de 10 productos que en texto plano
// ocupa 2.221.
//
// Y no se paga una sola vez. En la Responses API los resultados quedan dentro
// de la cadena de previous_response_id y se reenvían en todos los turnos
// siguientes; en la Assistants API quedan en el thread. El contexto crece
// ~14.700 tokens por turno y la conversación muere en el turno 11 con
// context_length_exceeded. (Reproducido sobre la config 10, columna 6554.)
//
// Bajar el tope ataca las dos cosas a la vez: menos tokens por llamada y,
// sobre todo, mucho menos lastre acumulado por turno.
//
// LAS DOS APIs PIDEN FORMAS DISTINTAS
//   Responses  → plano sobre el tool:  { type, vector_store_ids, max_num_results }
//   Assistants → anidado:              { type, file_search: { max_num_results } }
// De ahí que haya dos constructores en vez de un objeto suelto.
//
// ⚠️ HASTA DÓNDE LLEGA ESTO HOY
//
// Solo a las configs de CONFIGS_CON_TOPE (hoy: la 10), y solo por la Responses
// API. El lado Assistants está escrito y medido pero NO conectado: ver
// toolFileSearchAssistants / normalizarToolsAssistants al final del archivo.
//
// La razón es el alcance. ensureAssistantHasFileSearch corre en CADA
// sincronización, y las sincronizaciones se disparan cada vez que alguien
// guarda un producto, así que conectarlo le cambia el tope a las 238 cuentas
// de golpe. El 5 está medido contra un catálogo de 10 productos (2.899 tokens);
// hay 5 cuentas por encima de 16.000 tokens de catálogo (261, 285, 403, 277,
// 666) donde 5 fragmentos podrían quedarse cortos en preguntas amplias del
// tipo "¿qué productos tienes?". Falta medirlas antes de soltarlo.
// ════════════════════════════════════════════════════════════

// Fragmentos por búsqueda. El default de OpenAI es 20.
//
// El 5 está medido, no elegido a ojo. Sobre la config 10, preguntando precio,
// combos, descripción, otro producto y un listado general:
//
//   N=20 → 19.624 tokens/llamada   5/5 respuestas correctas  (default actual)
//   N=10 → 12.511                  5/5
//   N=8  → 11.098                  5/5
//   N=5  →  8.908                  5/5   ← elegido
//   N=3  →  7.413                  4/5   ✗ falla "¿qué productos tienes?"
//
// Descontando el prompt (~4.870 tokens), los fragmentos pasan de 14.750 a
// 4.040: un 73% menos. En 3 se cae, así que 5 es el punto justo con un turno
// de margen.
const MAX_RESULTADOS = 5;

// ranking_options.score_threshold queda SIN configurar a propósito.
//
// Medido: con umbral 0.5 el ahorro extra es del 4% (8.908 → 8.591 tokens),
// y a cambio una pregunta vaga puede quedarse sin ningún fragmento por encima
// del umbral. Que el bot conteste "no encontré información" cuesta mucho más
// que esos tokens. Si algún día se retoma, hay que medirlo con los catálogos
// grandes (cfg 261 tiene 181 productos), no con este.

// Configuraciones con el tope activo. Misma convención que USAR_RESPONSES_API
// y CONFIGS_CON_CATALOGO_INLINE: lista escrita a mano para ver de un vistazo
// hasta dónde llegó la migración.
//
// En producción la Responses API ya está limitada a la 10 por
// USAR_RESPONSES_API, así que esta lista sobra ahí. Hace falta por
// chat_prueba, que sí llama a la Responses API para CUALQUIER cuenta y sin
// esto le bajaría el tope al chat de prueba de las 238.
const CONFIGS_CON_TOPE = [10];

// ─────────────────────────────────────────────────────────────
// Responses API
//
// Sin id_configuracion (o con una que no esté en la lista) devuelve la tool
// sin tope, o sea el comportamiento de siempre: hasta 20 fragmentos.
// ─────────────────────────────────────────────────────────────
function toolFileSearchResponses(vectorStoreIds, id_configuracion) {
  // Se recibe la lista con huecos a propósito —normalmente
  // [catálogo, documentos], y el catálogo llega en null cuando va inline— así
  // que quien llama no tiene que filtrar. El slice(0, 2) es el tope duro de la
  // API: más de 2 vector stores en una llamada es error 400.
  const stores = [...new Set((vectorStoreIds || []).filter(Boolean))].slice(
    0,
    2,
  );
  if (!stores.length) return null;

  const tool = {
    type: 'file_search',
    vector_store_ids: stores,
  };

  if (CONFIGS_CON_TOPE.includes(Number(id_configuracion))) {
    tool.max_num_results = MAX_RESULTADOS;
  }

  return tool;
}

// ═════════════════════════════════════════════════════════════
// Assistants API (sistema viejo) — ⚠️ NO CONECTADO TODAVÍA
//
// Lo de aquí abajo está escrito, probado contra la API (OpenAI acepta la forma
// anidada; se verificó creando y borrando un assistant de prueba) y listo para
// enchufar, pero HOY NO LO LLAMA NADIE. Se dejó a propósito: conectarlo toca a
// las 238 cuentas de una vez y falta medir los catálogos grandes.
//
// Para activarlo hay que volver a poner normalizarToolsAssistants en:
//   - syncCatalogoKanbanColumna.service.js  → ensureAssistantHasFileSearch
//   - kanban_asistente.controller.js        → subirArchivo (rama Assistants)
//   - carga_file_productos.js               → ensureAssistantHasFileSearch
// y toolFileSearchAssistants() en los 4 sitios de kanban_plantillas.controller.js
// que crean assistants.
// ═════════════════════════════════════════════════════════════
function toolFileSearchAssistants() {
  return {
    type: 'file_search',
    file_search: { max_num_results: MAX_RESULTADOS },
  };
}

// ─────────────────────────────────────────────────────────────
// normalizarToolsAssistants
//
// Devuelve la lista de tools con el file_search ya configurado, conservando
// cualquier otra herramienta (funciones, code_interpreter…).
//
// Reemplaza el file_search existente en vez de respetarlo. Es a propósito: los
// asistentes ya creados lo tienen "pelado" (`{ type: 'file_search' }`, sin
// tope), y el código de sincronización decía
//     hasFileSearch ? currentTools : [...currentTools, { type: 'file_search' }]
// o sea, si ya existía lo dejaba igual. Con esa lógica ningún asistente vivo
// habría recibido nunca el tope. Normalizando aquí, cada asistente se corrige
// solo la próxima vez que se sincroniza su catálogo.
// ─────────────────────────────────────────────────────────────
function normalizarToolsAssistants(tools) {
  const otros = (Array.isArray(tools) ? tools : []).filter(
    (t) => t?.type !== 'file_search',
  );
  return [...otros, toolFileSearchAssistants()];
}

module.exports = {
  MAX_RESULTADOS,
  toolFileSearchResponses,
  toolFileSearchAssistants,
  normalizarToolsAssistants,
};
