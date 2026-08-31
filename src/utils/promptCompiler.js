// utils/promptCompiler.js
//
// ════════════════════════════════════════════════════════════
// Compilador de prompts para asistentes Kanban
// ════════════════════════════════════════════════════════════
//
// Toma un prompt base (con o sin placeholders) y los datos de
// personalización del cliente, y devuelve el prompt final listo
// para enviar a OpenAI como `instructions` del assistant.
//
// PLACEHOLDERS SOPORTADOS:
//   [NOMBRE_TIENDA]              → nombre_tienda
//   [NOMBRE_ASISTENTE]           → nombre_asistente_publico
//   [BLOQUE_INFO_ENVIO]          → política de envío del cliente
//                                   (si no hay, usa los DEFAULTS del prompt)
//   [BLOQUE_TONO_PERSONALIZADO]  → ajuste de tono opcional
//   [BLOQUE_INSTRUCCIONES_EXTRA] → reglas extra opcionales
// Soporte legacy: si el prompt base tiene nombres hardcodeados viejos
// (Comprapor, IMPORSHOP, mexve, Sara), también se reemplazan.
// ════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// Helpers internos
// ──────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatearBloque(titulo, contenido) {
  const c = (contenido || '').trim();
  if (!c) return '';
  return `\n${titulo}\n${c}\n`;
}

const MARCA_INI_EXTRA = '===== REGLAS ADICIONALES DE LA TIENDA =====';
const MARCA_FIN_EXTRA = '===== FIN REGLAS ADICIONALES =====';

// ──────────────────────────────────────────────────────────────
// Bloque de retiro en agencia Servientrega (switch de plataforma)
//
// Lo enciende el interruptor "retiro en agencia" de la vista kanban config
// (configuraciones.retiro_agencia_activo, piloto en la config 10). Va con
// marcas propias para poder ponerlo y quitarlo de un prompt ya compilado sin
// tocar el resto (ver aplicarBloqueRetiroAgencia). NO ocupa
// [BLOQUE_INFO_ENVIO]: ese sigue siendo la política de envío que el cliente
// escribe en el modal de personalizar.
// ──────────────────────────────────────────────────────────────
const MARCA_INI_RETIRO = '===== RETIRO EN AGENCIA SERVIENTREGA (BLOQUE DE PLATAFORMA) =====';
const MARCA_FIN_RETIRO = '===== FIN RETIRO EN AGENCIA SERVIENTREGA =====';

const NOMBRE_ARCHIVO_AGENCIAS = 'AGENCIAS_SERVIENTREGA_RETIRO_OFICINA.txt';

function construirBloqueRetiroAgencia() {
  return `
${MARCA_INI_RETIRO}
(Bloque administrado por la plataforma con el interruptor "Retiro en agencia".
No editar a mano: al apagar el interruptor este bloque se retira solo.)

Tienes un archivo de conocimiento llamado ${NOMBRE_ARCHIVO_AGENCIAS}: el
directorio de oficinas Servientrega habilitadas para retiro, organizado por
provincia y ciudad — cada oficina con su sector y su dirección exacta.

⚠️ PRIORIDAD MÁXIMA: esta sección MANDA sobre cualquier otra instrucción de
este prompt que hable del retiro o de la agencia. En particular quedan
ANULADAS mientras el pedido sea con retiro: cualquier paso del flujo que pida
nombre/teléfono/dirección INMEDIATAMENTE después de que el cliente elija
"agencia" (el paso de la agencia va primero), y cualquier frase tipo "puedes
retirar en el punto Servientrega más cercano a ti" (nunca la digas: tú
ofreces oficinas CONCRETAS del directorio).

CUÁNDO USARLO — solo cuando el cliente YA eligió retiro:
El directorio se consulta ÚNICAMENTE después de que el cliente escribió con
sus propias palabras que quiere retirar en una oficina/agencia Servientrega.
Mientras no haya elegido entre oficina y domicilio, no le muestres ninguna
oficina (conocer su ciudad NO basta): pregúntale primero cómo prefiere
recibir su pedido. La modalidad siempre se pregunta, nunca se asume.

CÓMO OFRECER LAS OFICINAS:
1. En cuanto el cliente elija agencia/oficina, tu SIGUIENTE mensaje es
   ofrecerle las oficinas de su ciudad (los demás datos del pedido se piden
   DESPUÉS de que elija una). Usa la CIUDAD que el cliente ya dio en la
   conversación (y su sector, barrio o referencia, si los dio); si todavía
   no tienes la ciudad, pregúntala antes.
2. Busca esa ciudad en el directorio y ofrécele de 3 a 5 oficinas reales de
   ESA ciudad, priorizando el sector más cercano a su referencia; copia el
   sector y la dirección TAL CUAL aparecen en el archivo. Si la ciudad tiene
   menos oficinas, ofrece las que haya. Nunca inventes una oficina ni una
   dirección, y nunca ofrezcas oficinas de otra ciudad.
   ⚠️ Cada oficina de tu lista lleva su dirección COMPLETA copiada del
   directorio. Prohibido escribir "(ver directorio)", "dirección disponible"
   o dejar una dirección a medias: si un resultado de búsqueda te llegó
   cortado, vuelve a buscar esa oficina, y si no la recuperas completa, no
   la incluyas en la lista.
3. Espera a que el cliente elija una. Esa oficina (sector + dirección) es la
   dirección de entrega del pedido.

CÓMO RECONOCER LA ELECCIÓN — INCLUIDOS NÚMEROS, ORDINALES Y TYPOS:
"la 1", "la primera", "la segunda", "la última", "esa", "la del scala", "la
de la Gasca" — todas son elecciones válidas de una oficina de TU ÚLTIMO
MENSAJE con oficinas, aunque vengan mal escritas ("la orimera" = la primera,
"la sgunda" = la segunda). La referencia es SIEMPRE a lo último que
ofreciste: si tu último mensaje ofreció UNA sola oficina ("¿Retiramos ahí?"),
entonces "sí", "esa", "la primera" o "está bien" eligen ESA oficina — nunca
vuelvas a una lista anterior. En cuanto elija, en tu SIGUIENTE mensaje
confirma la oficina elegida con su sector y dirección mientras pides el dato
que sigue:
"Perfecto, retiras en [sector] — [dirección] 😊 ¿Tu nombre completo?"
Desde ese momento ESA es la dirección del pedido y va TAL CUAL en el cierre.

⚠️ EN UN PEDIDO CON RETIRO NO EXISTE LA "DIRECCIÓN EXACTA":
Nunca pidas "tu dirección exacta", "2 calles + referencia" ni la dirección
del domicilio a quien eligió retiro: la dirección del pedido ES la oficina
elegida. Después de la oficina solo faltan nombre y teléfono; con esos dos,
cierras.

SI EL CLIENTE MENCIONA OTRO SECTOR O REFERENCIA — VUELVE A BUSCAR:
Cuando el cliente responde con un sector, barrio, centro comercial, calle o
ciudad cercana que NO está entre las opciones que ofreciste ("¿tienes una por
el centro comercial X?", "¿hay en [otro pueblo]?"), tu siguiente paso es
BUSCAR ESA REFERENCIA en el directorio (aparece en los nombres de sector y en
las direcciones) antes de responder:
- La encontraste → ofrece ESA oficina, sola: "Claro! Tenemos una en [sector]
  — [dirección]. ¿Retiramos ahí? 😊". Si la referencia es una ciudad propia
  del directorio, ofrece las oficinas de esa ciudad.
  ⚠️ NO rellenes la lista con otras oficinas presentándolas como "cercanas":
  solo puedes llamar "cerca de [referencia]" a una oficina cuyo sector o
  dirección CONTIENE esa referencia. Si quieres dar alternativas, preséntalas
  honesto: "y si te queda mejor otra zona, también hay en [sector]".
- No aparece en el directorio → dilo sin cerrar la puerta y reofrece lo que
  sí hay: "Por esa zona no tengo una oficina registrada 😊 Las que te puedo
  confirmar en [ciudad] son: [opciones]. ¿Te sirve alguna?"
Este ciclo de búsqueda se hace hasta DOS veces. Si tras dos búsquedas el
cliente sigue sin elegir (o insiste en que hay otra que no encuentras), recién
ahí aplicas la regla anti-desgaste y cierras con la agencia por confirmar,
INCLUYENDO la referencia que dio: así el dueño de la tienda la confirma con
el pedido ya tomado.

Ejemplo — el cliente responde "agencia servientrega" y su ciudad es Quito:
❌ MAL: "Perfecto! Último paso: dime tu nombre completo" (saltarse la
   elección de oficina)
✅ BIEN: "Perfecto! En Quito tienes estas oficinas para retirar:
   1) Sector [sector real] — [dirección real]
   2) Sector [sector real] — [dirección real]
   3) Sector [sector real] — [dirección real]
   ¿Cuál te queda mejor? 😊"

CANDADO DEL CIERRE CON RETIRO:
En el resumen final, la línea de dirección de un pedido con retiro SOLO puede
ser una de estas dos:
a) la oficina elegida, con sector + dirección COPIADOS del directorio, o
b) tras agotar las dos búsquedas de la regla anterior:
   "Agencia Servientrega de [ciudad] — por confirmar con un asesor
   (cliente sugirió: [referencia que dio el cliente])"
   — la parte "(cliente sugirió: ...)" va solo si dio una referencia.
PROHIBIDO cerrar con "Agencia Servientrega — [ciudad]", "Agencia [ciudad]",
"Agencia Servientrega [referencia] — [ciudad]" o cualquier oficina cuyo
sector y dirección no hayas COPIADO del directorio. Si el cliente nombró una
referencia que no pudiste verificar, eso NO es una oficina elegida: es el
caso b.
⚠️ ANTES de escribir "por confirmar", revisa el historial: ¿el cliente ya
eligió una oficina de tu lista (por número, ordinal, nombre o "esa")? Si la
eligió, "por confirmar" está PROHIBIDO — la dirección del cierre es la
oficina elegida, con su sector y dirección del directorio.

SI EL PEDIDO YA ESTÁ CERRADO (o esta columna atiende pedidos ya confirmados
o en camino): no vuelvas a ofrecer el flujo de selección de oficina. El
directorio te sirve solo para responder dudas puntuales ("¿dónde queda la
oficina?", "¿cuál es la dirección?") con datos reales.

REGLA ANTI-DESGASTE — máximo 3 mensajes sobre la oficina:
Si la ciudad no aparece en el directorio, el cliente no reconoce ninguna de
las opciones, o ya intercambiaron 3 mensajes sobre este tema sin resolverlo,
NO sigas insistiendo. Cierra el pedido normalmente usando como dirección:
"Agencia Servientrega de [ciudad del cliente] — por confirmar con un asesor"
y continúa el cierre con el resto de los datos que ya tienes. Nunca canceles
ni frenes la venta por no encontrar la oficina.

Nunca escribas frases como "no hay agencia en tu ciudad", "no tenemos
cobertura" o "no encontré agencias": o le ofreces oficinas del directorio, o
cierras con la agencia por confirmar.
${MARCA_FIN_RETIRO}
`;
}

// Quita cualquier copia del bloque (por sus marcas). Se usa SIEMPRE antes de
// poner uno nuevo: si el cliente editó el prompt a mano con el switch
// encendido, el bloque viaja dentro de su texto al snapshot, y sin este paso
// la siguiente compilación lo duplicaría.
function quitarBloqueRetiroAgencia(texto) {
  const re = new RegExp(
    `\\n*${escapeRegex(MARCA_INI_RETIRO)}[\\s\\S]*?${escapeRegex(MARCA_FIN_RETIRO)}\\n*`,
    'g',
  );
  return String(texto || '').replace(re, '\n').trim();
}

// Pone o quita el bloque sobre un prompt YA compilado (lo usa el toggle para
// no obligar a re-personalizar). Idempotente en los dos sentidos.
function aplicarBloqueRetiroAgencia(texto, activo) {
  const sinBloque = quitarBloqueRetiroAgencia(texto);
  if (!activo) return sinBloque;
  return `${sinBloque}\n${construirBloqueRetiroAgencia()}`.trim();
}

// Si el cliente NO escribió nada → devuelve string vacío.
// Si el cliente SÍ escribió reglas → devuelve:
//
//   INSTRUCCIONES ADICIONALES (cumplir siempre):
//   EN TODAS LAS INTERACCIONES:
//   <reglas del cliente>
// Esta función ELIMINA cualquier "EN TODAS LAS INTERACCIONES:" que el
// cliente haya escrito por su cuenta (case-insensitive) para evitar
// duplicados — la cabecera se inyecta SOLO desde aquí.
function construirBloqueInstruccionesExtra(instruccionesExtra) {
  const valor = (instruccionesExtra || '').trim();
  if (!valor) return '';

  const limpio = valor
    .split('\n')
    .filter(
      (linea) => !/^en\s+todas\s+las\s+interacciones:\s*$/i.test(linea.trim()),
    )
    .join('\n')
    .trim();

  if (!limpio) return '';

  return `\n${MARCA_INI_EXTRA}\nINSTRUCCIONES ADICIONALES (cumplir siempre):\nEN TODAS LAS INTERACCIONES:\n${limpio}\n${MARCA_FIN_EXTRA}\n`;
}

function quitarBloqueInstruccionesExtra(texto) {
  if (!texto || typeof texto !== 'string') return texto || '';
  const re = new RegExp(
    `\\n*${escapeRegex(MARCA_INI_EXTRA)}[\\s\\S]*?${escapeRegex(MARCA_FIN_EXTRA)}\\n*`,
    'g',
  );
  return texto.replace(re, '\n').trim();
}

function limpiarPlaceholdersHuerfanos(prompt) {
  return (
    prompt
      // Bloques no resueltos → eliminar línea completa
      .replace(/\[BLOQUE_[A-Z_]+\]\s*\n?/g, '')
      // [NOMBRE_TIENDA] huérfano → fallback genérico
      .replace(/\[NOMBRE_TIENDA\]/g, 'nuestra tienda')
      // [NOMBRE_ASISTENTE] huérfano → mantiene "Sara" por default
      .replace(/\[NOMBRE_ASISTENTE\]/g, 'Sara')
  );
}

// ──────────────────────────────────────────────────────────────
// Lista de nombres LEGACY de TIENDAS
// ──────────────────────────────────────────────────────────────
const NOMBRES_TIENDA_LEGACY = [
  'Comprapor TIENDA',
  'Comprapor',
  'IMPORSHOP TIENDA',
  'IMPORSHOP',
  'importshop',
  'mexve TIENDA',
  'mexve',
];

// ──────────────────────────────────────────────────────────────
// Lista de nombres LEGACY de ASISTENTES
// ──────────────────────────────────────────────────────────────
const NOMBRES_ASISTENTE_LEGACY = ['Sara'];

// ──────────────────────────────────────────────────────────────
// Bloque de envío con default exclusivo
// ──────────────────────────────────────────────────────────────
function construirBloqueInfoEnvio(infoEnvio) {
  const valor = (infoEnvio || '').trim();

  if (valor) {
    // Cliente personalizó: solo se muestra su política
    return `\nPOLITICA ESPECIFICA DE ESTA TIENDA:\n${valor}\n`;
  }

  // Cliente no personalizó: se muestran defaults
  return `\nDEFAULTS DE LA TIENDA:\n- Envio GRATIS para el cliente.\n- Pago contraentrega (COD): el cliente paga AL RECIBIR el producto.\n`;
}

// ──────────────────────────────────────────────────────────────
// Función principal
// ──────────────────────────────────────────────────────────────

/**
 * Compila el prompt final a partir del prompt base y la personalización.
 *
 * @param {string} promptBase - Prompt original de la plantilla global
 * @param {object} personalizacion - Datos del cliente
 * @param {string} [personalizacion.nombre_tienda]
 * @param {string} [personalizacion.nombre_asistente_publico]
 * @param {string} [personalizacion.instrucciones_extra]
 * @param {string} [personalizacion.info_envio]
 * @param {string} [personalizacion.tono_personalizado]
 * @returns {string} Prompt compilado listo para OpenAI
 */
function compilarPromptFinal(promptBase, personalizacion = {}) {
  if (!promptBase || typeof promptBase !== 'string') return '';

  const perso = personalizacion || {};
  const nombreTienda = (perso.nombre_tienda || '').trim();
  const nombreAsistente = (perso.nombre_asistente_publico || '').trim();

  let prompt = promptBase;

  // ── 1. Placeholders explícitos del nombre de tienda ────────
  if (nombreTienda) {
    prompt = prompt
      .replace(/\[NOMBRE_TIENDA\]/g, nombreTienda)
      .replace(/\[empresa\]/gi, nombreTienda)
      .replace(/\{empresa\}/gi, nombreTienda)
      .replace(/\{\{empresa\}\}/g, nombreTienda);
  }

  // ── 2. Placeholder explícito del nombre de asistente ───────
  if (nombreAsistente) {
    prompt = prompt.replace(/\[NOMBRE_ASISTENTE\]/g, nombreAsistente);
  }

  // ── 3. Bloque de envío (lógica especial: default exclusivo) ──
  prompt = prompt.replace(
    /\[BLOQUE_INFO_ENVIO\]/g,
    construirBloqueInfoEnvio(perso.info_envio),
  );

  // ── 4. Bloque de instrucciones extra (con cabecera inviolable) ──

  prompt = prompt.replace(
    /\[BLOQUE_INSTRUCCIONES_EXTRA\]/g,
    construirBloqueInstruccionesExtra(perso.instrucciones_extra),
  );

  // ── 5. Bloque opcional de tono ─────────────────────────────
  prompt = prompt.replace(
    /\[BLOQUE_TONO_PERSONALIZADO\]/g,
    formatearBloque('AJUSTE DE TONO:', perso.tono_personalizado),
  );

  // ── 5b. Bloque de retiro en agencia (switch de plataforma) ─
  // Primero se quita cualquier copia que venga pegada en el snapshot (pasa
  // cuando el cliente editó el prompt a mano con el switch encendido). Con el
  // switch ON: rellena [BLOQUE_RETIRO_AGENCIA] si la plantilla lo trae, o lo
  // agrega al final si no (las plantillas de hoy no tienen el placeholder).
  // Con el switch OFF no se agrega nada y el placeholder huérfano lo limpia
  // el paso 9 — el prompt queda igual que siempre.
  prompt = quitarBloqueRetiroAgencia(prompt);
  if (perso.retiro_agencia) {
    if (/\[BLOQUE_RETIRO_AGENCIA\]/.test(prompt)) {
      prompt = prompt.replace(
        /\[BLOQUE_RETIRO_AGENCIA\]/g,
        construirBloqueRetiroAgencia(),
      );
    } else {
      prompt = `${prompt}\n${construirBloqueRetiroAgencia()}`;
    }
  }

  // ── 6. Eliminar bloque de productos destacados (deprecated) ─
  prompt = prompt.replace(/\[BLOQUE_PRODUCTOS_DESTACADOS\]\s*\n?/g, '');

  // ── 7. Reemplazos legacy de TIENDAS ────────────────────────
  if (nombreTienda) {
    for (const legacy of NOMBRES_TIENDA_LEGACY) {
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'gi');
      prompt = prompt.replace(re, nombreTienda);
    }
  }

  // ── 8. Reemplazos legacy de ASISTENTES ─────────────────────
  if (nombreAsistente) {
    for (const legacy of NOMBRES_ASISTENTE_LEGACY) {
      if (legacy.toLowerCase() === nombreAsistente.toLowerCase()) continue;
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'g');
      prompt = prompt.replace(re, nombreAsistente);
    }
  }

  // ── 9. Limpiar placeholders huérfanos ──────────────────────
  prompt = limpiarPlaceholdersHuerfanos(prompt);

  // ── 10. Normalizar saltos de línea (max 2 consecutivos) ────
  prompt = prompt.replace(/\n{3,}/g, '\n\n');

  return prompt.trim();
}

// ──────────────────────────────────────────────────────────────
// Validación de personalización
// ──────────────────────────────────────────────────────────────
function validarPersonalizacion(perso = {}) {
  const errores = [];

  if (
    perso.nombre_tienda == null ||
    String(perso.nombre_tienda).trim().length === 0
  ) {
    errores.push('nombre_tienda es obligatorio');
  } else if (String(perso.nombre_tienda).trim().length > 100) {
    errores.push('nombre_tienda excede 100 caracteres');
  }

  if (perso.nombre_asistente_publico != null) {
    const n = String(perso.nombre_asistente_publico).trim();
    if (n.length === 0) {
      // Permitir vacío explícito
    } else if (n.length > 60) {
      errores.push('nombre_asistente_publico excede 60 caracteres');
    } else if (!/^[a-zA-ZÀ-ÿ\s'-]+$/.test(n)) {
      errores.push(
        'nombre_asistente_publico solo puede contener letras, espacios, guiones y apóstrofes',
      );
    }
  }

  const camposLargos = [
    'instrucciones_extra',
    'info_envio',
    'tono_personalizado',
  ];

  for (const campo of camposLargos) {
    if (perso[campo] != null) {
      const v = String(perso[campo]);
      if (v.length > 4000) {
        errores.push(`${campo} excede 4000 caracteres`);
      }
    }
  }

  return errores.length ? { valido: false, errores } : { valido: true };
}

// ──────────────────────────────────────────────────────────────
// Helper: ¿el prompt base usa placeholders nuevos?
// ──────────────────────────────────────────────────────────────
function detectarTipoPrompt(promptBase) {
  if (!promptBase) return 'vacio';
  const tienePlaceholders =
    /\[NOMBRE_TIENDA\]|\[NOMBRE_ASISTENTE\]|\[BLOQUE_/.test(promptBase);
  const tieneLegacy =
    NOMBRES_TIENDA_LEGACY.some((n) =>
      new RegExp(`\\b${escapeRegex(n)}\\b`, 'i').test(promptBase),
    ) ||
    NOMBRES_ASISTENTE_LEGACY.some((n) =>
      new RegExp(`\\b${escapeRegex(n)}\\b`).test(promptBase),
    );
  if (tienePlaceholders && tieneLegacy) return 'mixto';
  if (tienePlaceholders) return 'moderno';
  if (tieneLegacy) return 'legacy';
  return 'sin_marcadores';
}

module.exports = {
  compilarPromptFinal,
  validarPersonalizacion,
  detectarTipoPrompt,
  quitarBloqueInstruccionesExtra,
  NOMBRES_TIENDA_LEGACY,
  construirBloqueRetiroAgencia,
  aplicarBloqueRetiroAgencia,
  quitarBloqueRetiroAgencia,
  NOMBRE_ARCHIVO_AGENCIAS,
};
