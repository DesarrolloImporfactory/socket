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
// Soporta DOS formas de personalización:
//
// 1. Placeholders explícitos (forma nueva, recomendada):
//    [NOMBRE_TIENDA]              → personalizacion.nombre_tienda
//    [NOMBRE_ASISTENTE]           → personalizacion.nombre_asistente_publico
//    [BLOQUE_INSTRUCCIONES_EXTRA] → bloque formateado o ''
//    [BLOQUE_INFO_ENVIO]          → bloque formateado o ''
//    [BLOQUE_PRODUCTOS_DESTACADOS]→ bloque formateado o ''
//    [BLOQUE_TONO_PERSONALIZADO]  → bloque formateado o ''
//
// 2. Reemplazos legacy (prompts viejos con nombres hardcodeados
//    como "Comprapor", "IMPORSHOP", "mexve", "Sara"):
//    Solo se reemplazan si hay personalización configurada.
//
// Si no hay personalización, el prompt base se devuelve casi tal cual
// (se limpian los placeholders vacíos para que no aparezcan en OpenAI).
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
// Si en el futuro aparece otra plantilla con otro nombre hardcodeado,
// agregalo acá. ORDEN IMPORTA: del más específico al más genérico
// (ej: "Comprapor TIENDA" antes que "Comprapor").
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
// Lista de nombres LEGACY de ASISTENTES (personalidades)
// ──────────────────────────────────────────────────────────────
// Estos son nombres con los que el bot se presenta al cliente final.
// Solo se reemplazan si el cliente configuró nombre_asistente_publico.
// ──────────────────────────────────────────────────────────────
const NOMBRES_ASISTENTE_LEGACY = ['Sara'];

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
 * @param {string} [personalizacion.productos_destacados]
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

  // ── 3. Bloques opcionales ──────────────────────────────────
  prompt = prompt.replace(
    /\[BLOQUE_INSTRUCCIONES_EXTRA\]/g,
    formatearBloque(
      'INSTRUCCIONES ADICIONALES (cumplir siempre):',
      perso.instrucciones_extra,
    ),
  );

  prompt = prompt.replace(
    /\[BLOQUE_INFO_ENVIO\]/g,
    formatearBloque('POLITICA DE ENVIO ESPECIFICA:', perso.info_envio),
  );

  prompt = prompt.replace(
    /\[BLOQUE_PRODUCTOS_DESTACADOS\]/g,
    formatearBloque(
      'PRODUCTOS A DESTACAR (mencionar cuando aplique):',
      perso.productos_destacados,
    ),
  );

  prompt = prompt.replace(
    /\[BLOQUE_TONO_PERSONALIZADO\]/g,
    formatearBloque('AJUSTE DE TONO:', perso.tono_personalizado),
  );

  // ── 4. Reemplazos legacy de TIENDAS ────────────────────────
  if (nombreTienda) {
    for (const legacy of NOMBRES_TIENDA_LEGACY) {
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'gi');
      prompt = prompt.replace(re, nombreTienda);
    }
  }

  // ── 5. Reemplazos legacy de ASISTENTES ─────────────────────
  // Solo si el cliente cambió el nombre Y el nombre nuevo no es
  // el mismo que el legacy (sino haríamos reemplazo inútil).
  if (nombreAsistente) {
    for (const legacy of NOMBRES_ASISTENTE_LEGACY) {
      if (legacy.toLowerCase() === nombreAsistente.toLowerCase()) continue;
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'g');
      prompt = prompt.replace(re, nombreAsistente);
    }
  }

  // ── 6. Limpiar placeholders huérfanos ──────────────────────
  prompt = limpiarPlaceholdersHuerfanos(prompt);

  // ── 7. Normalizar saltos de línea (max 2 consecutivos) ─────
  prompt = prompt.replace(/\n{3,}/g, '\n\n');

  return prompt.trim();
}

// ──────────────────────────────────────────────────────────────
// Validación de personalización
// ──────────────────────────────────────────────────────────────

/**
 * Valida los campos de personalización antes de guardar.
 * Devuelve { valido: true } o { valido: false, errores: [...] }
 *
 * REGLAS:
 * - nombre_tienda es OBLIGATORIO (no puede ser null ni vacío)
 * - nombre_asistente_publico es opcional, solo letras/espacios/'-`
 * - campos largos máximo 4000 chars
 */
function validarPersonalizacion(perso = {}) {
  const errores = [];

  // nombre_tienda OBLIGATORIO
  if (
    perso.nombre_tienda == null ||
    String(perso.nombre_tienda).trim().length === 0
  ) {
    errores.push('nombre_tienda es obligatorio');
  } else if (String(perso.nombre_tienda).trim().length > 100) {
    errores.push('nombre_tienda excede 100 caracteres');
  }

  // nombre_asistente_publico OPCIONAL
  if (perso.nombre_asistente_publico != null) {
    const n = String(perso.nombre_asistente_publico).trim();
    if (n.length === 0) {
      // Permitir vacío explícito (lo trataremos como "sin valor")
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
    'productos_destacados',
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
};
