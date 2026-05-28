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
};
