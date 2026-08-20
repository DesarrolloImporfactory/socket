/* ¿Qué producto del catálogo nombra este texto?
 *
 * Lo usan dos puntos de kanban_ia.service: adjuntar la foto del producto que
 * el bot nombró (paso 12) y enrutar a `venta_producto` cuando el cliente
 * nombra uno. Antes cada uno tenía su copia de la misma regla —"dos palabras
 * del nombre de más de 3 letras"— sin lista de palabras vacías.
 *
 * CASO REAL (405, Celia, 2026-08-20): el bot escribió "solo me falta tu nombre
 * COMPLETO, teléfono y dirección exacta PARA completar el pedido" y el código
 * le adjuntó la foto del "Kit COMPLETO 800 vinchas PARA Auto": "completo" y
 * "para" son dos palabras del nombre. Le pasó a 5 clientes de esa cuenta en
 * un día, justo al pedir la dirección, y el negocio tenía que entrar a borrar
 * la foto. El dedupe de media no lo ve: es OTRA foto, no una repetida.
 *
 * LA REGLA AHORA
 *  - Solo cuentan las palabras que distinguen: fuera artículos, preposiciones,
 *    muletillas (la base curada + la lista MEDIDA palabrasFrecuentesChat.json,
 *    igual que contextoColumna) y las genéricas de catálogo ("completo",
 *    "kit", "set", "original", "premium"...).
 *  - Match por palabra ENTERA (con plural), no por substring: "cabeza" no es
 *    "cabezal".
 *  - Hacen falta las dos palabras si el nombre tiene dos; con más, al menos
 *    el 60 % (mínimo dos). Un nombre de una sola palabra útil, esa palabra.
 *  - Si varios califican, gana el de más aciertos (el nombre más específico),
 *    no el primero del catálogo. */

const VACIAS = new Set([
  // gramática
  'para','por','con','sin','del','las','los','una','uno','unos','unas','que',
  'como','mas','menos','muy','este','esta','esto','estos','estas','ese','esa',
  'eso','esos','esas','aquel','aquella','desde','hasta','sobre','entre','hacia',
  'donde','cuando','cual','cuales','quien','pero','porque','tambien','donde',
  // genéricas de catálogo / marketing: no distinguen un producto de otro
  'completo','completa','completos','completas','nuevo','nueva','nuevos','nuevas',
  'original','originales','premium','profesional','profesionales','pro','max',
  'mini','plus','super','mega','ultra','kit','set','pack','combo','combos',
  'unidad','unidades','pieza','piezas','par','pares','modelo','version','edicion',
  'oferta','promocion','promo','producto','productos','gratis','envio','envios',
  'calidad','importado','importada','marca','tipo','color','colores','talla',
  'tallas','tamano','grande','pequeno','mediano','hombre','mujer','ninos','nino',
  'nina','adulto','adultos','multifuncion','multiuso','portatil','inalambrico',
  'inalambrica','recargable','electrico','electrica','digital','automatico',
  'automatica','manual','doble','triple','gran','alta','alto','bajo','baja',
]);
try {
  for (const p of require('./palabrasFrecuentesChat.json')) VACIAS.add(p);
} catch {
  /* sin la lista medida: la base alcanza */
}

const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* Palabras del nombre que sí distinguen: 4+ letras, no vacías, no números. */
function tokensProducto(nombre) {
  return [
    ...new Set(
      normalizar(nombre)
        .split(' ')
        .filter((t) => t.length > 3 && !VACIAS.has(t) && !/^\d+$/.test(t)),
    ),
  ];
}

const RE_CACHE = new Map();
function rePalabra(t) {
  let re = RE_CACHE.get(t);
  if (!re) {
    // palabra entera, con plural en -s / -es
    re = new RegExp(`(?:^|\\s)${t}(?:s|es)?(?=\\s|$)`);
    RE_CACHE.set(t, re);
  }
  return re;
}

function aciertosDe(texto, tokens) {
  return tokens.filter((t) => rePalabra(t).test(texto)).length;
}

function aciertosNecesarios(n) {
  if (n <= 0) return Infinity; // nombre sin palabras útiles: nunca matchea
  if (n <= 2) return n;
  return Math.max(2, Math.ceil(n * 0.6));
}

/**
 * @param {string} texto        lo que dijo el bot o el cliente
 * @param {Array<{nombre:string}>} productos
 * @returns {object|null}       el producto nombrado (el de más aciertos) o null
 */
function productoNombrado(texto, productos) {
  const dicho = normalizar(texto);
  if (!dicho) return null;
  let mejor = null;
  let mejorAciertos = 0;
  let mejorTokens = 0;
  for (const p of productos || []) {
    const tk = tokensProducto(p?.nombre);
    const ac = aciertosDe(dicho, tk);
    if (ac < aciertosNecesarios(tk.length)) continue;
    if (
      ac > mejorAciertos ||
      (ac === mejorAciertos && tk.length > mejorTokens)
    ) {
      mejor = p;
      mejorAciertos = ac;
      mejorTokens = tk.length;
    }
  }
  return mejor;
}

module.exports = { productoNombrado, tokensProducto, normalizar, VACIAS };
