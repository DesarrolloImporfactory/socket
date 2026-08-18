// ════════════════════════════════════════════════════════════
// normalizarDocumento.js
// Mejora el indexado de los PDFs subidos como archivos de conocimiento:
// los convierte a texto "una línea por registro, campos etiquetados" y
// reemplaza el PDF por ese TXT dentro del vector store de la columna.
//
// POR QUÉ: la capa de texto de los PDFs tabulares (agencias, listas de
// precios, sucursales) se trocea mal en los fragmentos de file_search y las
// parejas nombre-dato salen corridas. Caso 569 del 2026-08-18: el bot no
// encontraba "QUITO_AV. DEL MAESTRO" o daba la dirección de otra agencia.
// Convertido a una línea por registro agrupada por ciudad, la búsqueda
// acertó al primer intento en todas las corridas.
//
// CÓMO (todo verificable, sin pasos "de fe"):
//   1. El PDF ya quedó adjuntado a un vector store (flujo normal de
//      subirArchivo). OpenAI lo parsea al indexarlo, y ese texto se LEE por
//      API (GET /vector_stores/{vs}/files/{id}/content). Medido con el PDF
//      de agencias: la extracción sale en orden de flujo, con las filas
//      bien pareadas — el desalineado es de la capa visual, no del stream.
//   2. Un modelo clasifica si el documento es tabular. Los de prosa
//      (políticas, guías) se dejan como están: el PDF ya indexa bien.
//   3. El texto se reescribe POR BLOQUES de pocas filas (sin visión y sin
//      pedir transcripciones larguísimas: probado que los modelos las
//      abandonan a la mitad SIN marcar la salida como incompleta — con el
//      PDF de agencias, la visión transcribió 126/592 registros y después
//      "declaró fin" en 90). Cada bloque se VERIFICA por contenido: el
//      token más distintivo de cada fila de entrada tiene que aparecer en
//      la salida; si faltan más del 5% tras un reintento, TODO se descarta
//      y el PDF original queda como estaba.
//   4. Con todos los bloques verificados: el TXT se sube a OpenAI Files, se
//      adjunta al mismo vector store y el PDF se DESADJUNTA (el archivo
//      original queda en Files como respaldo re-procesable).
//
// Está pensado para correr DESPUÉS de responderle al usuario (tarda 1-3
// minutos): la subida se comporta como siempre y esta mejora llega sola.
// Cualquier fallo deja el PDF original adjuntado — la normalización es
// mejora, nunca requisito.
// ════════════════════════════════════════════════════════════

const axios = require('axios');
const FormData = require('form-data');

// 40 y no más: medido con el listado de agencias (18 páginas), a 120 filas
// por bloque el modelo transcribe ~80 y abandona; a 40 transcribe completo.
const LINEAS_POR_BLOQUE = 40;
const MODELO_NORMALIZAR = 'gpt-4o-mini';

const headersJson = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
});
const headersBase = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'OpenAI-Beta': 'assistants=v2',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function completarTexto(apiKey, instructions, input, max_output_tokens) {
  const res = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: MODELO_NORMALIZAR,
      instructions,
      input,
      store: false,
      max_output_tokens,
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 180000 },
  );
  const msg = (res.data?.output || []).find((o) => o.type === 'message');
  return msg?.content?.find((c) => c.type === 'output_text')?.text || '';
}

// ── 1. Texto parseado del PDF, tal como lo indexó OpenAI ─────
async function obtenerTextoParseado(vectorStoreId, file_id, apiKey) {
  const res = await axios.get(
    `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${file_id}/content`,
    { headers: headersBase(apiKey), timeout: 60000 },
  );
  return (res.data?.data || [])
    .map((x) => x.text || '')
    .join('\n')
    // Los marcadores del parser (<PARSED TEXT FOR PAGE…>, <IMAGE FOR
    // PAGE…>) no son registros.
    .replace(/<[A-Z][A-Z ]*FOR PAGE:[^>]*>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ── 1.5 Unir filas partidas en varias líneas ─────────────────
// En los reportes tabulares las celdas largas parten la fila en 2-3 líneas
// ("CUENCA_AV. GIL RAMIREZ DAVALOS" / "AV.GIL RAMIREZ… N3-" / "89 FRENTE A
// LA GASOLINERA SI"). Un bloque lleno de fragmentos confunde al modelo (
// medido: perdía ~20 de 40) y el corte entre bloques puede partir un
// registro en dos. La señal para unirlas se saca del PROPIO documento: si
// una gran mayoría de líneas termina con el mismo token corto (SI, NO,
// ACTIVO — la última columna del reporte), ese token es el terminador de
// fila y todo lo que no termine en él es una fila partida. Sin terminador
// dominante, se deja como está.
function unirFilasPartidas(lineas) {
  const ultimos = new Map();
  for (const l of lineas) {
    const t = l.split(/\s+/).pop();
    if (t && t.length <= 8) ultimos.set(t, (ultimos.get(t) || 0) + 1);
  }
  const dominante = [...ultimos.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominante || dominante[1] < lineas.length * 0.6) return lineas;

  const terminador = dominante[0];
  const filas = [];
  let buffer = '';
  for (const l of lineas) {
    buffer = buffer ? `${buffer} ${l}` : l;
    if (l.endsWith(terminador)) {
      filas.push(buffer);
      buffer = '';
    }
  }
  if (buffer) filas.push(buffer);
  return filas;
}

// ── 2. ¿Es un documento tabular? ─────────────────────────────
async function esTabular(lineas, apiKey) {
  const muestra = lineas.slice(0, 40).join('\n').slice(0, 3000);
  const r = await completarTexto(
    apiKey,
    'Responde una sola palabra: SI o NO.',
    `¿Este documento es principalmente TABULAR (tabla o listado de registros ` +
      `con columnas repetidas: sucursales, precios, direcciones, inventario)?\n\n${muestra}`,
    16,
  );
  return /\bSI\b/i.test(r);
}

// ── 3. Reescritura por bloques, con conteo verificado ────────
async function normalizarBloque(encabezado, lineas, apiKey) {
  const instrucciones =
    'Reescribes filas de una tabla para búsqueda semántica (file_search). ' +
    'Para CADA fila de entrada, escribe UNA línea de salida con los campos ' +
    'etiquetados según el encabezado, separados por " | " (ej. "Agencia ' +
    'PADRE LASSO | Ciudad: 24 DE MAYO | Provincia: MANABI | Dirección: ' +
    '... | Habilitado: SI"). Conserva los valores EXACTOS, no inventes, no ' +
    'resumas, no omitas ninguna fila, no agregues comentarios ni líneas ' +
    'extra. Conserva también el código o identificador original de cada ' +
    'registro TAL CUAL aparece (ej. "Código: BANOS_PRINCIPAL"): sirve para ' +
    'buscarlo. Si una línea de entrada no es un registro (título, basura de ' +
    'parseo), omítela. Devuelve SOLO las líneas.';
  const entrada =
    `ENCABEZADO DE LA TABLA (nombres de las columnas):\n${encabezado}\n\n` +
    `FILAS:\n${lineas.join('\n')}`;

  const salida = await completarTexto(apiKey, instrucciones, entrada, 16000);
  return {
    lineas: salida
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('|')),
    raw: salida,
  };
}

/**
 * Orquestador. Llamar DESPUÉS de que el PDF quedó adjuntado e indexado.
 * Nunca lanza: devuelve { ok, motivo }.
 */
async function mejorarIndexadoPdf({ vectorStoreId, file_id, filename, apiKey, log }) {
  const decir = typeof log === 'function' ? log : (m) => console.log(m);
  try {
    const lineas = await obtenerTextoParseado(vectorStoreId, file_id, apiKey);
    if (lineas.length < 15) {
      return { ok: false, motivo: 'documento muy corto: se queda el original' };
    }

    if (!(await esTabular(lineas, apiKey))) {
      return { ok: false, motivo: 'documento de prosa: el PDF original indexa bien' };
    }

    // El encabezado son las primeras líneas (hasta 3) que no parecen registro
    // largo; se pasa a todos los bloques para que etiqueten igual.
    const encabezado = lineas.slice(0, 3).join('\n');

    /* Los encabezados de página se repiten idénticos en cada página (medido:
       18 repeticiones en el PDF de agencias) y NO son registros: el modelo
       los omite bien, pero si se quedan en el conteo, la verificación de
       bloques acusa filas faltantes que nunca existieron (32 salidas por 40
       "filas" era exactamente eso). Un registro real no se repite idéntico
       tantas veces. */
    const repeticiones = new Map();
    for (const l of lineas) repeticiones.set(l, (repeticiones.get(l) || 0) + 1);
    const filas = unirFilasPartidas(
      lineas.slice(3).filter((l) => repeticiones.get(l) < 3),
    );

    /* Verificación por CONTENIDO, no por conteo de líneas: hay filas del PDF
       que llegan partidas en dos líneas y el modelo las fusiona (bien) en un
       registro, así que "N líneas de entrada = N de salida" acusa faltantes
       que no existen. En cambio, el token más distintivo de cada línea de
       entrada (≥6 caracteres: una calle, un código, un nombre propio) TIENE
       que aparecer en la salida — un registro omitido pierde su token y se
       detecta, esté fusionado o no. */
    const tokenDistintivo = (l) => {
      const tokens = l.match(/[A-ZÁÉÍÓÚÑ0-9.-]{6,}/gi) || [];
      return tokens.sort((a, b) => b.length - a.length)[0] || null;
    };
    const faltantes = (bloque, raw) => {
      const perdidos = [];
      for (const l of bloque) {
        const t = tokenDistintivo(l);
        if (t && !raw.includes(t)) perdidos.push(t);
      }
      return perdidos;
    };
    const cuadra = (bloque, r) =>
      faltantes(bloque, r.raw).length <= Math.max(1, bloque.length * 0.05) &&
      r.lineas.length <= bloque.length * 1.5 &&
      r.lineas.length > 0;

    const resultado = [];
    for (let i = 0; i < filas.length; i += LINEAS_POR_BLOQUE) {
      const bloque = filas.slice(i, i + LINEAS_POR_BLOQUE);
      let r = await normalizarBloque(encabezado, bloque, apiKey);

      if (!cuadra(bloque, r)) {
        decir(
          `[normalizarDocumento] bloque ${i / LINEAS_POR_BLOQUE + 1}: ` +
            `faltan ${faltantes(bloque, r.raw).length} registro(s) ` +
            `(${faltantes(bloque, r.raw).slice(0, 3).join(', ')}…) — reintento`,
        );
        r = await normalizarBloque(encabezado, bloque, apiKey);
        if (!cuadra(bloque, r)) {
          return {
            ok: false,
            motivo:
              `bloque ${i / LINEAS_POR_BLOQUE + 1}: faltan ` +
              `${faltantes(bloque, r.raw).length} registro(s) tras reintento — ` +
              `se queda el original`,
          };
        }
      }
      resultado.push(...r.lineas);
    }

    const texto =
      `${(filename || 'documento').replace(/\.pdf$/i, '')} — versión indexable.\n` +
      `Cada línea es un registro completo del documento original.\n\n` +
      resultado.join('\n');

    // 4a. Subir el TXT a OpenAI Files
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', Buffer.from(texto, 'utf8'), {
      filename: `${(filename || 'documento').replace(/\.pdf$/i, '')}_indexable.txt`,
      contentType: 'text/plain',
    });
    const up = await axios.post('https://api.openai.com/v1/files', form, {
      headers: { ...headersBase(apiKey), ...form.getHeaders() },
      maxBodyLength: Infinity,
    });
    const txt_file_id = up.data?.id;
    if (!txt_file_id) return { ok: false, motivo: 'OpenAI no devolvió file_id del TXT' };

    // 4b. Adjuntar el TXT y esperar su indexación
    await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id: txt_file_id },
      { headers: headersJson(apiKey) },
    );
    let status = 'in_progress';
    for (let i = 0; i < 30 && status === 'in_progress'; i++) {
      await sleep(1000);
      const poll = await axios.get(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${txt_file_id}`,
        { headers: headersJson(apiKey) },
      );
      status = poll.data?.status;
    }
    if (status !== 'completed') {
      return { ok: false, motivo: `TXT no indexó (status=${status}): se queda el original` };
    }

    // 4c. Desadjuntar el PDF del store (el archivo queda en Files de respaldo)
    await axios
      .delete(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${file_id}`,
        { headers: headersJson(apiKey) },
      )
      .catch(() => {});

    decir(
      `[normalizarDocumento] "${filename}" → ${resultado.length} registros ` +
        `indexables (${txt_file_id}); el PDF quedó de respaldo en Files`,
    );
    return { ok: true, registros: resultado.length, txt_file_id };
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    decir(`[normalizarDocumento] "${filename}": ${msg} — se queda el original`);
    return { ok: false, motivo: msg };
  }
}

module.exports = { mejorarIndexadoPdf };
