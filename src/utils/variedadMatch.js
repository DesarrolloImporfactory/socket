'use strict';

/**
 * Matching TOLERANTE de variedades (color / talla / modelo) entre lo que
 * escribe el cliente y las etiquetas que devuelve Dropi.
 *
 * Por qué existe: en 30 días (ago-sep 2026) 388 auto-órdenes cayeron a
 * manual por "falta elegir la variedad" y 137 por "variedad no confirmada por
 * el cliente", y una parte grande NO era falta de dato sino comparación
 * literal: "roja" ≠ "ROJO", "café" ≠ "Cafe", "M negra" ≠ "MN", "XXL" ≠
 * "XL/2XL". Aquí se comparan formas canónicas: sin acentos, sin género ni
 * plural, colores por sinónimo, tallas normalizadas y el código
 * talla+inicial-de-color (MN, LB, 2XLN…) que usan varios proveedores.
 *
 * Lo usan el auto-orden (elegir la variante y el candado anti-invento) y la
 * ficha del pedido (saber si el cliente ya dijo su variedad antes de cerrar).
 * Nunca adivina entre dos candidatas: si hay ambigüedad devuelve null.
 */

const COLORES = {
  negro: ['negro', 'negra', 'negros', 'negras', 'black'],
  blanco: ['blanco', 'blanca', 'blancos', 'blancas', 'white'],
  cafe: ['cafe', 'cafes', 'marron', 'marrones', 'brown', 'chocolate'],
  rojo: ['rojo', 'roja', 'rojos', 'rojas', 'red', 'vino', 'guinda'],
  azul: ['azul', 'azules', 'blue', 'marino', 'navy'],
  verde: ['verde', 'verdes', 'green', 'militar', 'oliva'],
  rosado: ['rosado', 'rosada', 'rosa', 'rosados', 'rosadas', 'pink', 'fucsia'],
  gris: ['gris', 'grises', 'gray', 'grey', 'plomo'],
  amarillo: ['amarillo', 'amarilla', 'amarillos', 'amarillas', 'yellow'],
  morado: ['morado', 'morada', 'lila', 'purpura', 'violeta', 'purple'],
  crema: ['crema', 'beige', 'cream', 'hueso', 'nude'],
  plateado: ['plateado', 'plateada', 'plata', 'silver'],
  dorado: ['dorado', 'dorada', 'oro', 'gold'],
  celeste: ['celeste', 'turquesa', 'cyan', 'cian'],
  naranja: ['naranja', 'naranjas', 'orange', 'anaranjado', 'anaranjada'],
  transparente: ['transparente', 'transparentes', 'clear'],
};
const CANON_COLOR = new Map();
for (const [canon, lista] of Object.entries(COLORES)) {
  for (const w of lista) CANON_COLOR.set(w, canon);
}

/* Tallas: todo a la forma que usa Dropi ("2XL", no "XXL"). */
const TALLAS = {
  xs: 'xs',
  s: 's',
  m: 'm',
  l: 'l',
  xl: 'xl',
  xxl: '2xl',
  '2xl': '2xl',
  xxxl: '3xl',
  '3xl': '3xl',
  xxxxl: '4xl',
  '4xl': '4xl',
};

const RELLENO_TOKENS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'en',
  'y',
  'o',
  'color',
  'talla',
  'tamano',
  'modelo',
  'variedad',
  'variante',
  'unidad',
  'unidades',
  'quiero',
  'el',
]);

function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Raíz simple: quita género/plural ("negras" → "negr", "roja" → "roj"). */
function raiz(w) {
  if (w.length <= 3) return w;
  return w.replace(/(as|os|es)$/, '').replace(/[aeos]$/, '');
}

/* Token canónico: color por sinónimo, talla normalizada, o raíz. */
function canon(tok) {
  const t = tok.toLowerCase();
  if (CANON_COLOR.has(t)) return CANON_COLOR.get(t);
  if (TALLAS[t]) return `talla:${TALLAS[t]}`;
  return raiz(t);
}

/* Tokens canónicos SIGNIFICATIVOS de un texto. Las etiquetas con "/" (rango
   "XL/2XL", "S/M/L") se abren en sus partes. */
function tokens(s) {
  return normalizar(s)
    .split(/[\s/]+/)
    .filter((t) => t && !RELLENO_TOKENS.has(t))
    .map(canon);
}

/* Código talla+color: "MN" = M Negro, "2XLB" = 2XL Blanco, "LC" = L Café…
   Devuelve { talla, color } si la etiqueta tiene esa forma, si no null. */
const INICIAL_COLOR = { n: 'negro', b: 'blanco', c: 'cafe', r: 'rojo', a: 'azul', g: 'gris', v: 'verde' };
function leerCodigoTallaColor(etiqueta) {
  const m = normalizar(etiqueta).match(/^(xs|s|m|l|xl|2xl|3xl|4xl|xxl|xxxl)([nbcragv])$/);
  if (!m) return null;
  return { talla: TALLAS[m[1]] || m[1], color: INICIAL_COLOR[m[2]] };
}

/* ¿La etiqueta de Dropi "está dicha" en el texto (mensajes del cliente o
   línea del bot)? Tolerante a género, plural, acentos, sinónimos, rangos y
   códigos talla+color. */
function etiquetaEnTexto(etiqueta, texto) {
  const et = normalizar(etiqueta);
  const tx = normalizar(texto);
  if (!et || !tx) return false;
  if (tx.includes(et)) return true;

  const tTx = new Set(tokens(tx));
  const partes = et.split('/').map((p) => p.trim()).filter(Boolean);

  // Rango "XL/2XL": basta con que el cliente haya dicho UNA de las partes.
  if (partes.length > 1) {
    return partes.some((p) => {
      const tp = tokens(p);
      return tp.length > 0 && tp.every((t) => tTx.has(t));
    });
  }

  // Código talla+color ("MN"): el cliente dijo la talla Y el color.
  const cod = leerCodigoTallaColor(et);
  if (cod) return tTx.has(`talla:${cod.talla}`) && tTx.has(cod.color);

  const tEt = tokens(et);
  return tEt.length > 0 && tEt.every((t) => tTx.has(t));
}

/**
 * Elige UNA etiqueta para lo que pidió el cliente. null si ninguna o si
 * varias calzan igual (nunca adivinar el color).
 * @param {string} pedida   lo que dijo el cliente / puso el bot ("roja", "M negra")
 * @param {string[]} etiquetas  etiquetas de Dropi ("ROJO", "MN", "XL/2XL")
 */
function resolverVariedad(pedida, etiquetas) {
  const p = normalizar(pedida);
  if (!p || !Array.isArray(etiquetas) || !etiquetas.length) return null;
  const lista = etiquetas.map((e) => ({ e, n: normalizar(e) }));

  // 1) igual literal
  let hit = lista.filter((x) => x.n === p);
  if (hit.length === 1) return hit[0].e;

  // 2) una contiene a la otra ("negro" ⊂ "negro mate")
  hit = lista.filter((x) => x.n && (x.n.includes(p) || p.includes(x.n)));
  if (hit.length === 1) return hit[0].e;

  // 3) tokens canónicos: todos los de la pedida están en la etiqueta o al revés
  const tp = tokens(p);
  if (tp.length) {
    hit = lista.filter((x) => {
      const te = tokens(x.n);
      if (!te.length) return false;
      const setE = new Set(te);
      const setP = new Set(tp);
      return tp.every((t) => setE.has(t)) || te.every((t) => setP.has(t));
    });
    if (hit.length === 1) return hit[0].e;
  }

  // 4) etiqueta de rango ("XL/2XL"): alguna parte igual a lo pedido
  hit = lista.filter((x) =>
    x.n.includes('/')
      ? x.n.split('/').some((parte) => {
          const tq = tokens(parte);
          return tq.length && tq.every((t) => tp.includes(t));
        })
      : false,
  );
  if (hit.length === 1) return hit[0].e;

  // 5) código talla+color: "M negra" → "MN"
  const talla = tp.find((t) => t.startsWith('talla:'))?.slice(6);
  const color = tp.find((t) => CANON_COLOR.has(t) || Object.keys(COLORES).includes(t));
  if (talla && color) {
    hit = lista.filter((x) => {
      const cod = leerCodigoTallaColor(x.n);
      return cod && cod.talla === talla && cod.color === color;
    });
    if (hit.length === 1) return hit[0].e;
  }

  return null;
}

module.exports = { resolverVariedad, etiquetaEnTexto, normalizarVariedad: normalizar };
