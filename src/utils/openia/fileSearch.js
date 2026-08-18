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
// CONFIGS_CON_CATALOGO_INLINE
//
// Cuentas que ya NO usan file_search para el catálogo: reciben el catálogo
// completo en texto dentro de las instrucciones (kanban_columnas.catalogo_inline).
// Misma convención que las listas de arriba: escrita a mano para ver de un
// vistazo hasta dónde llegó la migración.
//
// Vive acá y no en kanban_ia.service.js porque hay dos lugares que necesitan
// saberlo y tienen que coincidir:
//   - kanban_ia.service.js            → decide si manda el catálogo inline
//   - syncCatalogoKanbanColumna.js    → decide si un fallo indexando el vector
//                                       store puede tumbar el sync (para estas
//                                       cuentas no, el store no se lee)
// Duplicar la lista significaba que activar una cuenta en un archivo y olvidarla
// en el otro dejaba el sistema en un estado incoherente y silencioso.
//
// Hace falta además del tope de tokens porque GENERAR_CATALOGO_INLINE está
// activo para todos: cualquier cuenta que guarde un producto se llena su
// catalogo_inline, y sin esta lista pasaría a inline sola, sin que nadie lo
// decidiera. El tope dice "cabe"; esta lista dice "quiero".
// ─────────────────────────────────────────────────────────────
//
// Sacar una cuenta de acá la devuelve a file_search en el mensaje siguiente,
// sin migrar nada: es el rollback más rápido que hay.
//
// ── Interruptor general ───────────────────────────────────────
//
// Mismo patrón que TODAS en responsesApi.js: en true manda a TODAS las cuentas
// por inline y la lista de abajo pasa a ser historia de por dónde empezó.
//
// Voltearlo NO mete a nadie a la fuerza. Sigue mandando catalogoInlineActivo(),
// que exige que la columna tenga catálogo inline guardado y que quepa en
// TOPE_CATALOGO_INLINE. Medido sobre las 846 columnas con IA activa el
// 2026-08-14:
//
//   219  pasan a inline ya            (tienen texto y caben)
//    26  siguen en file_search        (se pasan del tope; el sistema las deja
//                                      solas, que es justo lo que se probó con
//                                      la 666)
//   601  siguen en file_search        (nunca sincronizaron desde que
//                                      GENERAR_CATALOGO_INLINE está en true;
//                                      se llenan solas al guardar un producto)
//
// Para volver atrás: false otra vez. Vuelve a mandar la lista y las cuentas
// regresan a file_search en el mensaje siguiente, sin migrar nada.
//
// ── 2026-08-17: SE VOLTEA ──────────────────────────────────────
// Las tandas 1 y 2 cubrieron las 10 cuentas de mayor tráfico sin incidentes de
// mecanismo, y el tope quedó probado en vivo con la 666 (no cabe → sigue en
// file_search sola). Lo que queda fuera de las tandas es MÁS chico que lo ya
// probado, así que seguir por tandas solo alargaba la exposición al bug que se
// quiere matar (fragmentos que cortan productos por la mitad).
// Qué mirar tras el deploy: en el log, cuentas pasando de 🔎 a 📄; las que no
// caben siguen diciendo "NO CABE" y es correcto. Rollback: false otra vez.
const TODAS_INLINE = true;
//
// ── Tanda 1 (2026-08-05) ──────────────────────────────────────
//   610 "Global Outlet ec Pruebas" → 19 productos, 5.599 tokens, 4.087 msgs/30d
//        Cabe holgado: PASA a inline. Es la primera cuenta fuera de la 10, y la
//        primera en estrenar el inline por la rama de Assistants
//        (additional_instructions). 3 de sus 4 columnas ya tienen el texto
//        guardado, así que entra sin esperar a que sincronice.
//
//   666 "VitalLust" → 90 productos, 31.094 tokens, 27.226 msgs/30d
//        NO cabe: se queda en file_search, y está acá A PROPÓSITO. Es la
//        prueba de que el tope hace su trabajo — que una cuenta habilitada
//        cuyo catálogo no entra siga funcionando por el camino viejo, sola,
//        sin que nadie la saque a mano. Es el mecanismo que va a proteger a
//        las 256 cuando esto se abra, y conviene verlo funcionando ahora y no
//        el día del rollout. En el log tiene que decir:
//          🔎 Catálogo por file_search (NO CABE: 31094 tokens > tope 16000)
//        Para que la 666 pasara a inline habría que subir el tope a ~32.000,
//        que es una decisión de costo aparte: son ~900 mensajes por día.
//
// ── Tanda 2 (2026-08-18) ──────────────────────────────────────
// Las 5 de mayor tráfico cuyo catálogo cabe (elegidas por mensajes/7d):
//   322 → 5.915 tokens, 16.253 msgs/7d
//   364 → 12.108, 15.103        819 → 3.793, 13.865
//   366 → 4.103, 13.141         548 → 6.353, 7.271 (la del caso pistola/$25)
// Qué mirar tras el deploy: en el log, esas cuentas tienen que pasar de
// 🔎 (file_search) a 📄 (catálogo INLINE). Rollback: sacarlas de la lista —
// vuelven a file_search en el mensaje siguiente, sin migrar nada.
const CONFIGS_CON_CATALOGO_INLINE = [
  10, 610, 666, 857, 411, 322, 364, 819, 366, 548,
];

// ⚠️ "QUIERE inline" ≠ "USA inline". Son dos preguntas distintas y confundirlas
// hace daño.
//
// usaCatalogoInline() responde solo por la lista: la cuenta está habilitada.
// Pero además el catálogo tiene que CABER, y eso no se sabe desde el
// id_configuracion: los tokens viven por columna en la BD. Una cuenta puede
// estar en la lista y seguir en file_search porque su catálogo se pasa del
// tope — que es justamente el comportamiento que se quiere (el sistema elige
// solo), pero significa que quien pregunte "¿va por inline?" tiene que pasar
// los tokens.
//
// Para eso está catalogoInlineActivo(). Usar usaCatalogoInline() donde hacía
// falta la segunda hacía, por ejemplo, que el sync se tragara en silencio un
// fallo de indexación en una cuenta que SÍ lee su vector store.
function usaCatalogoInline(id_configuracion) {
  if (TODAS_INLINE) return true;
  return CONFIGS_CON_CATALOGO_INLINE.includes(Number(id_configuracion));
}

// Tope para mandar el catálogo dentro de las instrucciones en vez de usar
// file_search. Vive acá, junto a la lista, porque el runtime y el servicio de
// sincronización tienen que decidir con el mismo número.
//
// Valores de referencia, medidos sobre los catálogos actuales (256 cuentas con
// asistente activo):
//   16000 → 247 de 256 (punto de equilibrio con file_search, que inyecta
//           ~16.000 tokens por llamada)
//   30000 → 251 de 256 (entran cfg 782, 485, 739 y 285)
//   Infinity → las 256 (cfg 261, con 182 productos, ~51.000 tokens)
//
// Ojo al comparar: el inline es PLANO —se reenvía igual cada turno y no queda
// guardado— mientras que los fragmentos de file_search se acumulan en la
// conversación y se re-cobran. 16.000 de file_search son 32.000 en el turno 2.
// O sea que el punto de equilibrio real está bastante más arriba de 16.000.
//
// ── 2026-08-17: sube a 30.000 ─────────────────────────────────
// Lo que decidió subirlo no fue el costo sino un error en vivo: en la 285
// (27.698 tokens, fuera del tope de 16k) el cliente preguntó "¿protege la
// cabeza?" y file_search recuperó el fragmento del "Intercomunicador
// Bluetooth para CASCO" — el bot respondió bien sobre la máscara pero mandó
// LA FOTO del intercomunicador, que venía dentro del fragmento. Ese cruce no
// existe en inline: el modelo ve el catálogo entero y exacto.
// En costo, 30k planos por turno son más baratos que file_search desde el
// turno 2 (16k+16k acumulados) en cualquier conversación de más de un turno.
// La 666 (31.094) queda fuera por poco: subirla es otro escalón de costo
// (~900 msgs/día) que se decide aparte.
const TOPE_CATALOGO_INLINE = 30000;

// La pregunta de verdad: ¿esta columna va por inline en esta llamada?
// Necesita los tokens del catálogo de la columna, no solo la cuenta.
function catalogoInlineActivo(id_configuracion, tokens) {
  const n = Number(tokens || 0);
  return (
    usaCatalogoInline(id_configuracion) && n > 0 && n <= TOPE_CATALOGO_INLINE
  );
}

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
  TODAS_INLINE,
  CONFIGS_CON_CATALOGO_INLINE,
  TOPE_CATALOGO_INLINE,
  usaCatalogoInline,
  catalogoInlineActivo,
  toolFileSearchResponses,
  toolFileSearchAssistants,
  normalizarToolsAssistants,
};
