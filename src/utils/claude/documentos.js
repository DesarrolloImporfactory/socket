// ════════════════════════════════════════════════════════════
// documentos.js — los «Archivos de conocimiento» de una columna, para Claude.
//
// Con OpenAI los documentos que sube el cliente (PDF, DOCX, XLSX…) van a un
// vector store y el modelo los consulta por file_search. Claude no tiene
// file_search, así que el texto del documento se extrae al subirlo
// (utils/claude/textoDeArchivo.js → kanban_archivos.texto_extraido) y acá se
// arma un bloque que va INLINE en las instrucciones, igual que el catálogo:
// el modelo lo tiene completo en cada respuesta y, con cache_control, el
// bloque repetido cuesta ~10 % desde el segundo turno.
//
// Tope: TOPE_CHARS_DOCS por columna (~15.000 tokens). Si los documentos de la
// columna suman más, se incluyen enteros los primeros (por fecha de subida)
// y el resto se recorta con un aviso; el log del motor dice cuánto entró.
// ════════════════════════════════════════════════════════════
'use strict';

const TOPE_CHARS_DOCS = 60000;

/**
 * Textos extraídos de los archivos vinculados a la columna. Si la columna
 * texto_extraido todavía no existe en la BD (migración pendiente) devuelve [].
 */
async function textosDocumentosColumna(id_kanban_columna) {
  const { db } = require('../../database/config');
  try {
    const filas = await db.query(
      `SELECT ka.id, ka.nombre_original, ka.texto_extraido
         FROM kanban_columna_archivos kca
         INNER JOIN kanban_archivos ka ON ka.id = kca.id_archivo
        WHERE kca.id_kanban_columna = ? AND ka.deleted_at IS NULL
        ORDER BY ka.created_at ASC`,
      { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
    );
    // Mismo nombre registrado dos veces (p. ej. el directorio de agencias,
    // que también lo registra la adopción): se queda el más reciente.
    const porNombre = new Map();
    for (const f of filas) porNombre.set(f.nombre_original, f);
    return [...porNombre.values()]
      .filter((f) => String(f.texto_extraido || '').trim())
      .map((f) => ({
        id: f.id,
        nombre: f.nombre_original,
        texto: String(f.texto_extraido).trim(),
      }));
  } catch (e) {
    if (/texto_extraido/i.test(String(e?.message))) return [];
    throw e;
  }
}

const PUENTE_DOCS =
  'DOCUMENTOS DE CONOCIMIENTO: los archivos que el negocio subió al asistente ' +
  'vienen a continuación con su texto completo. Donde estas instrucciones ' +
  'digan "file_search", "consulta los documentos" o "revisa el archivo", se ' +
  'refieren a esto: ya lo tienes aquí, no hay nada que buscar. Úsalos como ' +
  'fuente de verdad para lo que cubren; si algo no está en ellos ni en el ' +
  'catálogo, no lo inventes.';

/** Arma el bloque con tope. Devuelve '' si no hay documentos con texto. */
function armarBloqueDocumentos(docs, tope = TOPE_CHARS_DOCS) {
  if (!docs?.length) return '';
  const partes = [];
  let usado = 0;
  let recortados = 0;
  for (const d of docs) {
    const encabezado = `=== ${d.nombre} ===\n`;
    const disponible = tope - usado - encabezado.length;
    if (disponible <= 200) {
      recortados += 1;
      continue;
    }
    const cuerpo =
      d.texto.length > disponible
        ? `${d.texto.slice(0, disponible)}\n[… documento recortado por tamaño]`
        : d.texto;
    if (d.texto.length > disponible) recortados += 1;
    partes.push(encabezado + cuerpo);
    usado += encabezado.length + cuerpo.length;
  }
  if (!partes.length) return '';
  const aviso = recortados
    ? `\n\n[Nota: ${recortados} documento(s) no cupieron completos; si el cliente pregunta algo que no aparece, pásalo a un asesor.]`
    : '';
  return `${PUENTE_DOCS}\n\n${partes.join('\n\n')}${aviso}`;
}

/**
 * Bloque listo para pegar a las instrucciones de la columna cuando el
 * proveedor es Claude. '' si no hay documentos.
 * @returns {Promise<{bloque:string, docs:number, chars:number}>}
 */
async function bloqueDocumentosClaude(id_kanban_columna) {
  if (!id_kanban_columna) return { bloque: '', docs: 0, chars: 0 };
  const docs = await textosDocumentosColumna(id_kanban_columna);
  const bloque = armarBloqueDocumentos(docs);
  return { bloque, docs: docs.length, chars: bloque.length };
}

module.exports = {
  TOPE_CHARS_DOCS,
  PUENTE_DOCS,
  textosDocumentosColumna,
  armarBloqueDocumentos,
  bloqueDocumentosClaude,
};
