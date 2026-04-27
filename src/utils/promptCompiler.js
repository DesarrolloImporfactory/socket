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
//
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
// Usa esta lógica EXCLUYENTE: o muestra la política específica del
// cliente, o muestra los defaults. NUNCA las dos juntas — para que
// el bot no se confunda con información contradictoria.
//
// Si la plantilla tiene [BLOQUE_INFO_ENVIO]:
//   - Cliente personalizó info_envio → muestra "POLITICA ESPECIFICA DE ESTA TIENDA"
//   - Cliente NO personalizó         → muestra "DEFAULTS DE LA TIENDA"
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

  // ── 4. Bloques opcionales simples ──────────────────────────
  prompt = prompt.replace(
    /\[BLOQUE_INSTRUCCIONES_EXTRA\]/g,
    formatearBloque(
      'INSTRUCCIONES ADICIONALES (cumplir siempre):',
      perso.instrucciones_extra,
    ),
  );

  prompt = prompt.replace(
    /\[BLOQUE_TONO_PERSONALIZADO\]/g,
    formatearBloque('AJUSTE DE TONO:', perso.tono_personalizado),
  );

  // ── 5. Eliminar bloque de productos destacados (deprecated) ─
  // Si todavía aparece en alguna plantilla vieja, simplemente lo borramos.
  prompt = prompt.replace(/\[BLOQUE_PRODUCTOS_DESTACADOS\]\s*\n?/g, '');

  // ── 6. Reemplazos legacy de TIENDAS ────────────────────────
  if (nombreTienda) {
    for (const legacy of NOMBRES_TIENDA_LEGACY) {
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'gi');
      prompt = prompt.replace(re, nombreTienda);
    }
  }

  // ── 7. Reemplazos legacy de ASISTENTES ─────────────────────
  if (nombreAsistente) {
    for (const legacy of NOMBRES_ASISTENTE_LEGACY) {
      if (legacy.toLowerCase() === nombreAsistente.toLowerCase()) continue;
      const re = new RegExp(`\\b${escapeRegex(legacy)}\\b`, 'g');
      prompt = prompt.replace(re, nombreAsistente);
    }
  }

  // ── 8. Limpiar placeholders huérfanos ──────────────────────
  prompt = limpiarPlaceholdersHuerfanos(prompt);

  // ── 9. Normalizar saltos de línea (max 2 consecutivos) ─────
  prompt = prompt.replace(/\n{3,}/g, '\n\n');

  return prompt.trim();
}

// ──────────────────────────────────────────────────────────────
// Validación de personalización
// ──────────────────────────────────────────────────────────────

/**
 * Valida los campos de personalización antes de guardar.
 * REGLAS:
 * - nombre_tienda es OBLIGATORIO
 * - nombre_asistente_publico es opcional (solo letras/espacios/'-`)
 * - campos largos máximo 4000 chars
 *
 * NOTA: productos_destacados ya no se valida (deprecated).
 * Si viene en el payload se ignora silenciosamente.
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
};
