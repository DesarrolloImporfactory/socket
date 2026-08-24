// utils/wizardProducto/respuestasRapidas.js
// Elige, SIN tokens, la respuesta quemada que contesta la pregunta del cliente
// sobre un producto con wizard. Es determinista y conservador: ante la duda
// devuelve null y el turno sigue a la IA con el producto inyectado. Un falso
// positivo acá es peor que un acierto perdido (le contestaría al cliente algo
// que no preguntó en medio del cierre), por eso los umbrales son altos.
//
// Cada respuesta rápida trae `claves` (palabras que la identifican, las genera
// la IA en el wizard y el negocio las puede editar). El score es cuántas claves
// distintas aparecen en el mensaje; se exige 2, o 1 si el mensaje es claramente
// una pregunta corta.

/* OJO: acá NO se usa src/utils/palabrasFrecuentesChat.json. Esa lista mide lo
   que no distingue PRODUCTOS entre cuentas (y por eso incluye "envio",
   "garantia", "quito"...), pero para las preguntas frecuentes justamente
   esas palabras son el contenido. Solo se quita gramática y cortesía. */

const VACIAS_BASE = new Set(
  `el la los las un una unos unas de del al a y o u que como cual cuales
   cuanto cuanta cuantos cuantas donde cuando quien por para con sin en es son
   esta estan este esta esto eso ese esa hay tiene tienen tengo me te se le lo
   les nos mi tu su sus mis tus si no ya mas muy bien hola buenas buenos dias
   tardes noches gracias porfa favor quiero quisiera saber info informacion
   precio precios costo cuesta vale valor producto productos articulo ok dale
   listo puedo puede pueden podria podrian usted ustedes yo`
    .split(/\s+/)
    .filter(Boolean),
);

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s?¿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plural simple en s/es, igual que mismaPalabra() de contextoColumna. */
function raiz(palabra) {
  if (palabra.length > 4 && palabra.endsWith('es')) return palabra.slice(0, -2);
  if (palabra.length > 3 && palabra.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
}

function tokens(texto, { quitarVacias = true } = {}) {
  const limpio = normalizar(texto).replace(/[?¿]/g, ' ');
  const salida = [];
  for (const w of limpio.split(' ')) {
    if (!w || w.length < 3) continue;
    if (quitarVacias && VACIAS_BASE.has(w)) continue;
    salida.push(raiz(w));
  }
  return salida;
}

/* Primer mensaje típico desde un anuncio: saludo y/o "quiero info / precio".
   El mensaje fijo ya responde todo eso, así que no hace falta la IA. Es
   genérico cuando TODAS las palabras con contenido son de esta lista. */
const GENERICAS = new Set(
  `hola ola hello hey buenas buenos dias tardes noches saludos cordial cordiales
   interesa interesado interesada gustaria quiero quisiera deseo necesito saber
   conocer info informacion detalles detalle precio precios valor costo cuesta
   vale producto productos articulo anuncio publicacion publicidad oferta promo
   promocion esto este esta eso ese esa favor porfa porfavor gracias amigo amiga
   senor senora disculpe disculpa consulta pregunta ayuda mas sobre acerca
   cotizacion cotizar cotizame dame deme pasame paseme enviame mandame brindar
   brindeme`
    .split(/\s+/)
    .filter(Boolean)
    .map(raiz),
);

function esSaludoOGenerico(texto) {
  const toks = tokens(texto);
  if (!toks.length) return true;
  return toks.every((t) => GENERICAS.has(t));
}

/* "quiero 2", "el combo", "me lo llevo", "cómo compro": el cliente está
   comprando. Eso NUNCA se contesta con una quemada: sigue el flujo de cierre. */
const RE_COMPRA =
  /\b(quiero|quisiera|deseo|me llevo|me lo llevo|lo quiero|los quiero|mandame|enviame|envieme|mandeme|hagamos|hacer|realizar|confirmo|confirmar|proceder|comprar|compro|pedir|pido|ordenar|ordeno|reservar|apartar|separar)\b.*\b(\d+|uno|una|dos|tres|cuatro|cinco|el combo|los combos|combo|unidad|unidades|pedido|orden|compra|par|kit|promo|promocion)\b|\b(como|donde)\s+(lo\s+|los\s+)?(compro|pido|consigo|adquiero|ordeno)\b|\b(si|dale|listo|ok|okay|vale|bueno|perfecto|claro)\b[\s,.!]*(quiero|lo quiero|me lo llevo|compro|pido|el combo|\d+)\b|^\s*(\d+|uno|una|dos|tres)\s*(unidad|unidades|combo|combos)?\s*$|\b(el|la|los|las|un|una|dos|tres)\s+(combo|combos|unidad|unidades)\b|\bme interesa el combo\b|\b(me lo llevo|me los llevo|lo quiero|los quiero|la quiero|lo compro|lo llevo|si lo quiero|si quiero)\b[\s,.!]*$/i;

function pareceIntencionCompra(texto) {
  return RE_COMPRA.test(normalizar(texto));
}

const RE_INTERROGATIVO =
  /^(que|cual|cuales|como|cuanto|cuanta|cuantos|cuantas|donde|cuando|tiene|tienen|sirve|sirven|viene|vienen|incluye|incluyen|es|son|hay|puedo|puede|pueden|se puede|trae|traen|funciona|funcionan|dura|duran|hacen|hace|aceptan|acepta|entregan|entrega|llega|llegan|envian|envia|tardan|tarda|demora|demoran)\b/;

function pareceRegunta(texto) {
  const n = normalizar(texto);
  if (/[?¿]/.test(n)) return true;
  return RE_INTERROGATIVO.test(n);
}

/**
 * @param {string} mensaje texto del cliente
 * @param {Array<{pregunta:string, respuesta:string, claves?:string[], activa?:number}>} faqs
 * @returns {{ faq: object, score: number, indice: number } | null}
 */
function elegirRespuestaRapida(mensaje, faqs, { ignorarCompra = false } = {}) {
  if (!mensaje || !Array.isArray(faqs) || !faqs.length) return null;
  // Con intención de compra la quemada NO sale (sigue el cierre con la IA).
  // `ignorarCompra` es solo para que el simulador pueda explicar "habría
  // calzado con X, pero como quería comprar respondió la IA".
  if (!ignorarCompra && pareceIntencionCompra(mensaje)) return null;

  const toksMensaje = new Set(tokens(mensaje));
  if (!toksMensaje.size) return null;
  const largo = tokens(mensaje, { quitarVacias: false }).length;
  // Un mensaje largo es una historia, una dirección o varios pedidos juntos:
  // no se resuelve con una quemada.
  if (largo > 40) return null;

  const esPregunta = pareceRegunta(mensaje);
  const candidatos = [];

  faqs.forEach((faq, indice) => {
    if (!faq || faq.activa === 0 || faq.activa === false) return;
    if (!String(faq.respuesta || '').trim()) return;
    const clavesRaw = Array.isArray(faq.claves) && faq.claves.length
      ? faq.claves
      : [];
    // Claves declaradas + las palabras con contenido de la propia pregunta.
    const claves = new Set([
      ...clavesRaw.flatMap((c) => tokens(c)),
      ...tokens(faq.pregunta),
    ]);
    if (!claves.size) return;
    let score = 0;
    for (const c of claves) if (toksMensaje.has(c)) score += 1;
    if (score > 0) candidatos.push({ faq, indice, score });
  });

  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b.score - a.score);
  const top = candidatos[0];
  const empate = candidatos.length > 1 && candidatos[1].score === top.score;

  // En empate, mejor no adivinar (misma filosofía que el resolver de anuncios).
  if (empate) return null;
  if (top.score >= 2) return top;
  /* Una sola clave alcanza solo si es casi todo lo que dijo el cliente
     ("¿tiene garantía?", "¿el envío es gratis?"). "¿sirve para una tele de
     tubo vieja?" tiene una clave ("tele") entre cuatro palabras con contenido:
     eso es OTRA pregunta y va a la IA (caso real 2026-08-20, 3087). */
  const cobertura = top.score / Math.max(1, toksMensaje.size);
  if (top.score === 1 && esPregunta && toksMensaje.size <= 6 && cobertura >= 0.5) {
    return top;
  }
  return null;
}

module.exports = {
  normalizar,
  tokens,
  esSaludoOGenerico,
  pareceIntencionCompra,
  pareceRegunta,
  elegirRespuestaRapida,
};
