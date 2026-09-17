/**
 * Cláusula de búsqueda de contactos (clientes_chat_center) por nombre,
 * apellido, email o teléfono. Es la MISMA estrategia que usa el buscador de
 * /contactos (listarContactosEstadoDinamico) y ahora también el "+" del chat
 * (buscar destinatario para plantilla). Vive aquí para que no se dupliquen
 * dos criterios que después divergen.
 *
 * Estrategia según el término:
 *   - Teléfono (≥4 dígitos)  → sufijo invertido sobre celular_rev
 *                               (índice idx_ccc_cfg_celrev). Inmune al
 *                               formato: 0969…, 593969…, +593 969….
 *   - Texto con ≥3 letras     → FULLTEXT en modo booleano
 *                               (índice full_search_contact).
 *   - 1-2 caracteres          → LIKE por PREFIJO en nombre/apellido
 *                               (barato; nunca infix `%x%`).
 *
 * Todas usan índice: nunca hace `LIKE '%texto%'` sobre la tabla completa,
 * que era lo que reventaba el buscador del chat en cuentas grandes.
 */

const FT_MIN_TOKEN = 3; // innodb_ft_min_token_size (default 3)

const revStr = (s) => [...s].reverse().join('');

const toBooleanTerm = (term) =>
  term
    .replace(/[+\-><()~*"@]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= FT_MIN_TOKEN)
    .map((w) => `+${w}*`)
    .join(' ');

/**
 * @param {string} rawTerm  texto escrito por el usuario
 * @param {string} alias    alias de clientes_chat_center en la consulta
 * @returns {{frag: string, params: any[]} | null}  null si no hay término
 */
function buildSearchClause(rawTerm, alias = 'c') {
  const term = String(rawTerm || '').trim();
  if (!term) return null;

  const a = alias ? `${alias}.` : '';
  const digits = term.replace(/\D/g, '');
  // Es teléfono si tiene ≥4 dígitos y lo demás son separadores típicos de un
  // número (+, espacios, guiones, paréntesis, puntos). Antes se exigía que
  // hubiera como máximo 3 caracteres no numéricos: "+593 99 872 7912" (4
  // separadores) caía al FULLTEXT, que sobre tokens numéricos tarda ~10 s y
  // no encuentra nada.
  const esTelefono = digits.length >= 1 && /^[\d\s+\-().]+$/.test(term);

  // Teléfono → sufijo invertido (idx_ccc_cfg_celrev) O prefijo sobre
  // telefono_limpio (idx_clientes_telefono_limpio). El sufijo cubre el número
  // completo en cualquier formato (0999…, 593999…, +593 999…); el prefijo
  // cubre lo que la gente escribe de verdad: el inicio del número tal como
  // está guardado ("59399470" → los 593 99 470 xxxx). Con solo sufijo,
  // "59399470" devolvía 0 en el chat mientras /contactos mostraba 18.
  // MySQL lo resuelve con index_merge sort_union: 90 ms en una cuenta de
  // 90k contactos.
  if (esTelefono) {
    const clean = digits.replace(/^0+/, ''); // 0999… → 999…
    const prefijos = [...new Set([digits, clean])].filter(Boolean);
    const frags = prefijos.map(() => `${a}telefono_limpio LIKE ?`);
    const params = prefijos.map((p) => `${p}%`);
    // Sufijo solo con ≥4 dígitos: con menos no identifica nada y, sobre todo,
    // así "593" o "09" no caen al FULLTEXT (un token numérico corto contra
    // toda la tabla tardaba 8 s).
    if (clean.length >= 4) {
      frags.unshift(`${a}celular_rev LIKE ?`);
      params.unshift(`${revStr(clean)}%`);
    }
    return { frag: `(${frags.join(' OR ')})`, params };
  }

  // Texto ≥3 chars → FULLTEXT (usa full_search_contact)
  const bool = toBooleanTerm(term);
  if (bool) {
    return {
      frag: `MATCH(${a}nombre_cliente, ${a}apellido_cliente, ${a}email_cliente, ${a}celular_cliente, ${a}telefono_limpio)
               AGAINST (? IN BOOLEAN MODE)`,
      params: [bool],
    };
  }

  // 1-2 chars → LIKE por PREFIJO (barato, no infix)
  return {
    frag: `(${a}nombre_cliente LIKE ? OR ${a}apellido_cliente LIKE ?)`,
    params: [`${term}%`, `${term}%`],
  };
}

module.exports = { buildSearchClause, FT_MIN_TOKEN };
