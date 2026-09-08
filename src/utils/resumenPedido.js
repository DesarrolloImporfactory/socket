// utils/resumenPedido.js
// ─────────────────────────────────────────────────────────────
// Lectura determinística del resumen de cierre que escribe el bot.
//
// Caso real (cfg 411, 2026-09-08, Aracelly / 593979500161): la clienta pidió
// "dos", el bot cerró con "📦 Producto: Dr Melaxin x2" y "💰 Precio total:
// $40.00" (2 x $20 — ignoró el combo de 2 por $25 que él mismo había
// ofrecido), y como el resumen no traía la línea "🔢 Cantidad:", el
// auto-orden leyó cantidad 1: plantilla de confirmación "1 x Dr Melaxin" y
// orden en Dropi de UNA unidad por $40. El cliente lo reportó "en muchísimos
// chats": el formato "x<cantidad>" se lo dicta contextoColumna al modelo
// para los pedidos multi-producto y el modelo lo usa también con uno solo,
// pero el lector de un solo producto solo miraba la línea Cantidad.
//
// Aquí viven las dos redes, en código y para todas las cuentas:
//   - parsearLineaProducto: "Dr Melaxin x2" / "2 x Dr Melaxin" /
//     "Dr Melaxin (Variedad: Negro) x3" → { producto, cantidad, variedad }.
//   - corregirPrecioCombo: si el pedido es de N unidades, el catálogo tiene
//     un combo para N con precio P, y el total del bot es exactamente
//     unitario x N (la firma de "se olvidó del combo"), el total se corrige a
//     P. Nada más: un total distinto por otra razón (envío sumado, descuento
//     negociado, precio del prompt) no se toca.
// ─────────────────────────────────────────────────────────────

const { db } = require('../database/config');

function parsearPrecio(s) {
  const m = String(s || '')
    .replace(',', '.')
    .match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Lee UNA línea "Producto:" del resumen (ya sin el rótulo).
 * Devuelve { producto, cantidad, variedad } con cantidad como string
 * ('1' si no viene) — el mismo contrato que parsearProductosResumen.
 */
function parsearLineaProducto(linea) {
  let txt = String(linea || '').trim();
  const variedad =
    txt
      .match(/\(?\s*(?:Variedad|Variante|Color|Talla):\s*([^)\n]+)\)?/i)?.[1]
      ?.trim() || '';
  txt = txt
    .replace(/\(?\s*(?:Variedad|Variante|Color|Talla):\s*[^)\n]*\)?/i, '')
    .trim();
  // Cantidad: "… x2" al final (el formato dictado), "… (x2)", "… x 2 unidades"
  // o "2 x …" al inicio (como lo escriben algunos bots por su cuenta).
  const alFinal = txt.match(
    /[\s(]x\s*(\d+)\)?(?:\s*(?:unidad(?:es)?|u\.?|uds?\.?))?\s*$/i,
  );
  const alInicio = txt.match(/^(\d+)\s*x\s+/i);
  const cantidad = alFinal?.[1] || alInicio?.[1] || '1';
  txt = txt
    .replace(/[\s(]x\s*\d+\)?(?:\s*(?:unidad(?:es)?|u\.?|uds?\.?))?\s*$/i, '')
    .replace(/^\d+\s*x\s+/i, '')
    .replace(/[*_]/g, '')
    .replace(/[—–,-]\s*$/, '')
    .trim();
  return { producto: txt, cantidad, variedad };
}

/* Líneas del resumen: rótulo al inicio de línea con hasta 6 caracteres de
   adorno (emoji, asteriscos, guión), igual que el lector de kanban_ia. */
const RE_PRODUCTO = /(?:^|\n)[^\n]{0,6}?Producto\s*:\s*([^\n]+)/gi;
const RE_CANTIDAD = /(?:^|\n)[^\n]{0,6}?Cantidad\s*:\s*([^\n]+)/i;
const RE_PRECIO = /^([^\n]{0,6}?(?:Precio\s+total|\bTotal)\s*:\s*)(.+)$/im;

function leerCombos(prod) {
  try {
    const c = JSON.parse(prod?.combos_producto || '[]');
    return Array.isArray(c) ? c : [];
  } catch (_) {
    return [];
  }
}

/**
 * Corrige "💰 Precio total:" cuando el bot cobró unitario x N habiendo un
 * combo para N unidades en el catálogo.
 *
 * @param {string} texto  respuesta del bot (resumen de cierre)
 * @param {number} id_configuracion
 * @param {object} [opts]
 * @param {Array}  [opts.productos]  catálogo ya cargado (pruebas): filas con
 *                                   { nombre, precio, combos_producto }
 * @returns {Promise<null|{texto:string, motivo:string, de:number, a:number}>}
 */
async function corregirPrecioCombo(texto, id_configuracion, opts = {}) {
  const t = String(texto || '');
  const lineasProducto = [...t.matchAll(RE_PRODUCTO)].map((m) => m[1].trim());
  // Solo el pedido de UN producto: con varios, el total es la suma de
  // renglones y la validación vive en el auto-orden.
  if (lineasProducto.length !== 1) return null;

  const mPrecio = t.match(RE_PRECIO);
  if (!mPrecio) return null;
  const total = parsearPrecio(mPrecio[2]);
  if (total <= 0) return null;

  const linea = parsearLineaProducto(lineasProducto[0]);
  const cantidadTxt = t.match(RE_CANTIDAD)?.[1] || linea.cantidad;
  const cantidad = parseInt(String(cantidadTxt).replace(/\D/g, ''), 10) || 1;
  if (cantidad < 2 || !linea.producto) return null;

  let productos = opts.productos;
  if (!productos) {
    productos = await db.query(
      `SELECT id, nombre, precio, combos_producto
         FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0
          AND combos_producto IS NOT NULL AND combos_producto <> ''`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
  }
  if (!productos?.length) return null;

  // El mismo emparejador por nombre del auto-orden (exacto → contiene →
  // tokens). Require perezoso: dropiAutoOrder arrastra medio sistema.
  const { matchEnLista } = require('../services/dropiAutoOrder.service');
  const prod = matchEnLista(productos, linea.producto, (p) => p.nombre);
  if (!prod) return null;

  const combo = leerCombos(prod).find(
    (c) => Number(c?.cantidad) === cantidad && parsearPrecio(c?.precio) > 0,
  );
  if (!combo) return null;
  const precioCombo = parsearPrecio(combo.precio);
  const unitario = Number(prod.precio || 0);
  if (!(unitario > 0)) return null;

  const cobroUnitarioXN = Math.abs(total - unitario * cantidad) <= 0.5;
  if (!cobroUnitarioXN) return null; // otro motivo: no se adivina
  if (precioCombo >= total - 0.5) return null; // el combo no es más barato

  const conSigno = /\$/.test(mPrecio[2]);
  const nuevoValor = `${conSigno ? '$' : ''}${precioCombo.toFixed(2)}`;
  const nuevoTexto = t.replace(mPrecio[0], `${mPrecio[1]}${nuevoValor}`);
  return {
    texto: nuevoTexto,
    motivo:
      `"${prod.nombre}" x${cantidad}: el bot cobró unitario x${cantidad} ` +
      `($${total.toFixed(2)}) y el catálogo tiene combo de ${cantidad} por ` +
      `$${precioCombo.toFixed(2)}`,
    de: total,
    a: precioCombo,
  };
}

module.exports = {
  parsearLineaProducto,
  parsearPrecio,
  corregirPrecioCombo,
};
