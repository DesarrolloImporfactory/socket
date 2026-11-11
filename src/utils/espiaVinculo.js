/**
 * ImporKiller — ¿este anuncio es de este producto?
 *
 * El radar busca en la Biblioteca de Meta las 3 primeras palabras con peso del
 * nombre del producto (keyword_unordered) y hasta el 11-11-2026 vinculaba al
 * producto TODO lo que Meta devolvía. Medido ese día sobre 10.191 vínculos:
 * en el 43 % (EC) y 47 % (MX) al anuncio le faltaba alguna de las palabras
 * (Meta las encuentra en versiones o tarjetas que no se ven), en otro 17–23 %
 * estaban regadas por el texto (un producto parecido, no el mismo) y cientos
 * eran anunciantes en inglés que Meta muestra en el país pero no venden ahí.
 * «Brazalete Rosas» tenía una app de Google Play y «JJLBRO MENS» 33 anuncios
 * que no lo nombraban.
 *
 * La regla, sobre lo que se ve del anuncio (título, texto, página y destino):
 *   exacto   = todas las palabras, juntas (dentro de VENTANA palabras)
 *   parecido = todas las palabras pero regadas, o dos de tres juntas
 *   ninguno  = lo demás, o el anuncio está en inglés
 *
 * Es una comparación de texto: no mira la imagen ni el video. Un anuncio que
 * muestra el producto sin nombrarlo queda fuera (sigue en Anuncios y Tiendas).
 */

const VENTANA = 6;

// Las mismas palabras de relleno que quita el radar al armar la búsqueda
// (services/espia_mercado.service.js → terminoBusqueda).
const RELLENO = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'con', 'para', 'por', 'y', 'o', 'en', 'un', 'una', 'unos', 'unas', 'al', 'a', 'x',
  'pack', 'kit', 'set', 'combo', 'nuevo', 'nueva', 'nuevos', 'original', 'originales', 'oferta', 'promo', 'promocion', 'envio', 'gratis',
  'producto', 'productos', 'unidad', 'unidades', 'pcs', 'pza', 'pzas', 'piezas', 'pieza', 'par', 'pares', 'talla', 'color', 'colores',
  'mas', 'super', 'premium', 'calidad', 'alta', 'importado', 'importada', 'tipo', 'estilo', 'modelo', 'version', 'edicion',
  'ml', 'gr', 'g', 'kg', 'cm', 'mm', 'm', 'lt', 'l', 'oz', 'w', 'v', 'mah', 'gb', 'tb', 'pulgadas', 'pulg',
]);

// Letreros de la propia Biblioteca que la extensión recoge junto con el texto.
// Salen en inglés cuando el Chrome del radar está en inglés: se quitan antes de
// mirar el idioma para no tomar un anuncio en español por uno en inglés.
const LETREROS = [
  'this ad has multiple versions', 'this ad is not active for some audiences because it did not meet certain requirements',
  'low impression count', 'impressions', 'open dropdown', 'eu transparency', 'see ad details', 'see summary details',
  'ads use this creative and text', 'send whatsapp message', 'send message', 'shop now', 'learn more', 'sponsored', 'menu', 'play',
  'transparencia de la ue', 'abrir menu desplegable', 'numero de impresiones bajo', 'impresiones', 'este anuncio tiene varias versiones',
  'anuncios usan este contenido y texto', 'publicidad', 'instalar', 'install now',
];

const ES = new Set([
  'de', 'la', 'el', 'los', 'las', 'que', 'para', 'con', 'tu', 'tus', 'por', 'una', 'del', 'en', 'es', 'su', 'sus', 'mas', 'sin',
  'envio', 'gratis', 'paga', 'pago', 'recibir', 'ahora', 'hoy', 'compra', 'pide', 'precio', 'oferta', 'descuento', 'te', 'se', 'como', 'este', 'esta',
]);
const EN = new Set([
  'the', 'your', 'you', 'with', 'and', 'for', 'this', 'that', 'our', 'from', 'are', 'was', 'have', 'has', 'not', 'get', 'now', 'free',
  'shipping', 'of', 'to', 'is', 'in', 'it', 'on', 'my', 'more', 'just', 'how', 'why', 'what', 'when', 'can', 'will', 'day', 'days',
]);

const plano = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Las palabras que el radar le buscó a Meta para ese producto (sin tildes ni ñ, para comparar). */
function palabrasDelProducto(nombre) {
  const base = plano(nombre)
    .split(' ')
    .filter((w) => w && !RELLENO.has(w) && !/^\d+[a-z]*$/.test(w) && w.length >= 3);
  return [...new Set(base)].slice(0, 3);
}

// Letras de diferencia entre dos palabras (corta en cuanto pasa del tope).
function distancia(a, b, tope) {
  if (Math.abs(a.length - b.length) > tope) return tope + 1;
  let fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const nueva = [i];
    let minimo = i;
    for (let j = 1; j <= b.length; j += 1) {
      nueva[j] = Math.min(fila[j] + 1, nueva[j - 1] + 1, fila[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (nueva[j] < minimo) minimo = nueva[j];
    }
    if (minimo > tope) return tope + 1;
    fila = nueva;
  }
  return fila[b.length];
}

// «faja» cuenta en «fajas» (al revés no). Y una palabra larga cuenta aunque
// cambie una o dos letras: el producto se llama ASTAXANTHIN y quien lo vende
// en el país escribe «astaxantina».
function coincide(token, palabra) {
  if (token === palabra || token.startsWith(palabra)) return true;
  if (palabra.length < 7 || token[0] !== palabra[0]) return false;
  return distancia(token, palabra, 2) <= 2;
}

function estanJuntas(tokens, palabras) {
  const posiciones = palabras.map((p) => {
    const lista = [];
    tokens.forEach((t, i) => {
      if (coincide(t, p)) lista.push(i);
    });
    return lista;
  });
  if (posiciones.some((l) => !l.length)) return false;
  return posiciones[0].some((i) => posiciones.every((l) => l.some((j) => Math.abs(j - i) < VENTANA)));
}

/** true si el texto del anuncio está en inglés (y no en español). Con poco texto no opina. */
function estaEnIngles(textoCrudo) {
  let texto = ` ${plano(textoCrudo)} `;
  for (const l of LETREROS) texto = texto.split(` ${l} `).join(' ');
  const tokens = texto.split(' ').filter(Boolean);
  if (tokens.length < 8) return false;
  let es = 0;
  let en = 0;
  for (const t of tokens) {
    if (ES.has(t)) es += 1;
    else if (EN.has(t)) en += 1;
  }
  return en >= 4 && en > es * 2;
}

/**
 * anuncio: { titulo, texto, producto, pagina_nombre, dominio, url_destino }
 * → 'exacto' | 'parecido' | 'ninguno'
 */
function clasificarVinculo(nombreProducto, anuncio = {}) {
  const palabras = palabrasDelProducto(nombreProducto);
  if (!palabras.length) return 'ninguno';
  const cuerpo = [anuncio.titulo, anuncio.texto, anuncio.producto].filter(Boolean).join(' ');
  if (estaEnIngles(cuerpo)) return 'ninguno';
  const tokens = plano([cuerpo, anuncio.pagina_nombre, anuncio.dominio, anuncio.url_destino].filter(Boolean).join(' ')).split(' ');
  const presentes = palabras.filter((p) => tokens.some((t) => coincide(t, p)));
  if (presentes.length === palabras.length) {
    return palabras.length === 1 || estanJuntas(tokens, palabras) ? 'exacto' : 'parecido';
  }
  // De tres palabras falta una y las otras dos van juntas: «chaleco de
  // compresión» para «Chaleco De Compresion Disimulador». No alcanza para
  // exacto, pero es del mismo tipo de producto.
  if (palabras.length === 3 && presentes.length === 2 && estanJuntas(tokens, presentes)) return 'parecido';
  return 'ninguno';
}

module.exports = { clasificarVinculo, palabrasDelProducto, estaEnIngles, VENTANA };
