// ════════════════════════════════════════════════════════════
// sinRepetirPresentacion.js
// Con wizard activo, el bot no vuelve a recitar la lista de precios que el
// mensaje fijo ya mandó.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El mensaje fijo del wizard hace de una vez DOS pasos del guion de e-commerce:
// presenta (precio, combos, foto, video) y pregunta la ciudad. El guion los trae
// separados y numerados: "INTERACCIÓN 1: solo pregunta ciudad" → "INTERACCIÓN 2:
// responde con precio y combos + [producto_imagen_url] + ¿cuántas unidades?".
// Cuando el cliente contesta "quito", el modelo da por hecha la 1 y recita la 2
// textual: otra vez todos los precios, pegados debajo del mensaje que acababa
// de darlos (cfg 819, 2026-09-21).
//
// Se intentó primero por prompt (la ficha le muestra el mensaje fijo y le dice
// qué paso ya quedó hecho). Replay de 3 corridas con gpt-5-mini: 0 de 3. Un paso
// numerado con su texto literal le gana a cualquier regla escrita arriba. Por
// eso esto se resuelve acá, en código, igual que las repreguntas y el resumen
// repetido (utils/fichaPedido.js).
//
// QUÉ HACE, Y QUÉ NO
//
// Quita SOLO las frases que recitan la lista de precios, y deja el resto del
// mensaje (la pregunta que sigue). No toca nada cuando:
//   · el cliente preguntó por precio, combos, promo o total → ahí SÍ corresponde;
//   · la respuesta es el resumen o el cierre del pedido (lleva "Precio total");
//   · no es la lista completa (una sola mención suelta de un precio se respeta);
//   · al quitar las frases no queda un mensaje con sentido.
// Ante la duda, no recorta: repetir un precio molesta, borrar de más rompe.
// ════════════════════════════════════════════════════════════
const { combosValidos } = require('./componerMensajeInicial');

// El cliente está hablando de plata: la lista de precios es la respuesta correcta.
const PIDE_PRECIO =
  /(precio|cuest|cu[aá]nto|cuanto|vale|valor|costo|coste|combo|promo|oferta|descuent|rebaj|barat|\bcar[oa]s?\b|pagar|pago|total|\$)/i;

// Resumen o cierre del pedido: ahí el precio es un dato, no una presentación.
const ES_RESUMEN =
  /(precio total|total a pagar|\btotal\s*:|resumen|nombre\s*:|direcci[oó]n\s*:|tel[eé]fono\s*:|ciudad\s*:|\[[a-z_]+\]\s*:\s*true)/i;

// Frases de la presentación que no llevan cifra pero son parte de la lista.
const FRASE_DE_LISTA =
  /(tambi[eé]n tenemos (los )?(combos|\d)|tenemos (los )?(siguientes )?combos|^[-•*]\s*\d+\s*(por|x)\b)/i;

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Las formas en que el modelo escribe un precio: 21.99 · 21,99 · y, solo si va
// con el signo, $22 (un "2" suelto es una cantidad, no un precio).
function patronesDePrecio(valor) {
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return [];
  const [entero, dec] = n.toFixed(2).split('.');
  const pats = [new RegExp(`(?<![\\d.,])${escaparRegex(entero)}[.,]${dec}(?!\\d)`)];
  if (dec === '00') {
    // Seguido de un punto o coma de cierre sí vale ("cuesta $25."); seguido de
    // un decimal no ("$25.50" es otro precio).
    pats.push(new RegExp(`\\$\\s?${escaparRegex(entero)}(?!\\d|[.,]\\d)`));
  }
  return pats;
}

function preciosDelProducto(producto) {
  const valores = [producto?.precio];
  for (const c of combosValidos(producto?.combos_producto)) valores.push(c.precio);
  return valores.map(patronesDePrecio).filter((p) => p.length);
}

const mencionaAlguno = (texto, grupos) =>
  grupos.some((pats) => pats.some((re) => re.test(texto)));

// Corta en frases sin partir un decimal: "$21.99. También…" → dos frases.
function enFrases(linea) {
  return linea.split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡*_"“])/);
}

/**
 * @returns {{ texto: string, recortado: boolean }}
 */
function quitarPresentacionRepetida({ respuesta, mensajeCliente, producto }) {
  const original = String(respuesta || '');
  const intacto = { texto: original, recortado: false };
  if (!original.trim() || !producto) return intacto;

  if (PIDE_PRECIO.test(String(mensajeCliente || ''))) return intacto;
  if (ES_RESUMEN.test(original)) return intacto;

  const grupos = preciosDelProducto(producto);
  if (!grupos.length) return intacto;

  // ¿Es LA LISTA? Con combos: el unitario y al menos un combo (o dos combos).
  // Sin combos: el precio dicho como presentación ("cuesta $X").
  const mencionados = grupos.filter((pats) =>
    pats.some((re) => re.test(original)),
  ).length;
  const esLista =
    grupos.length > 1
      ? mencionados >= 2
      : mencionados === 1 && /(cuesta|precio|vale|est[aá] en)/i.test(original);
  if (!esLista) return intacto;

  const lineas = original.split('\n').map((linea) => {
    if (!linea.trim()) return linea;
    // Los marcadores de media no se tocan: de esos se ocupa dedupeMedia.
    if (/^\s*\[producto_(imagen|video|documento)_url\]/i.test(linea)) return linea;
    return enFrases(linea)
      .filter((f) => !mencionaAlguno(f, grupos) && !FRASE_DE_LISTA.test(f.trim()))
      .join(' ');
  });

  /* "También tenemos:" / "Combos:" — la frase que introducía la lista. Sus
     renglones ya se fueron, así que queda colgando. Se quita solo si lo que
     sigue NO es una viñeta (un "Beneficios:" con su lista intacta se respeta). */
  const esVineta = (l) => /^\s*[-•*]\s+\S/.test(l);
  const sinHuerfanas = lineas.filter((linea, i) => {
    if (!/:\s*$/.test(linea.trim())) return true;
    const siguiente = lineas.slice(i + 1).find((l) => l.trim());
    return Boolean(siguiente) && esVineta(siguiente);
  });

  const texto = sinHuerfanas
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Lo que queda tiene que seguir siendo un mensaje (la pregunta que venía
  // después de la lista). Si no, mejor repetir el precio que mandar un trozo.
  const soloTexto = texto.replace(/^\s*\[producto_\w+_url\].*$/gim, '').trim();
  if (soloTexto.replace(/[^a-záéíóúñ]/gi, '').length < 12) return intacto;

  return { texto, recortado: true };
}

module.exports = { quitarPresentacionRepetida };
