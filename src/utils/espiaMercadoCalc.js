'use strict';

/**
 * espiaMercadoCalc.js — cálculo puro del Espía de mercado (Dropkiller propio).
 *
 * Portado de `mercado_calc.py` (plan de Daniel, 27-oct-2026) para que el
 * recolector en Node sume ventas con la misma regla:
 *
 *  - La foto del stock se lleva por (producto, bodega, variación), nunca por
 *    la suma: si una bodega baja 10 y otra sube 50, la suma diría +40 y se
 *    perderían 10 ventas.
 *  - Por cada clave: si el stock baja → esas unidades son ventas; si sube →
 *    reabastecimiento (no resta ventas). La primera vez que se ve una clave
 *    no cuenta nada.
 *  - Las ventas se cargan a la fecha LOCAL del país de la foto ANTERIOR (la
 *    foto de las 02:00 cierra el día de ayer).
 *  - Dropi no lista las bodegas en 0: una bodega que tenía stock y deja de
 *    aparecer se cuenta como bajada a 0 (`completarClaves`).
 *
 * Límites conocidos (van dichos en la pantalla): un traslado entre bodegas o
 * un ajuste a 0 parece venta; una venta tapada por una reposición en la misma
 * ventana no se ve; lo propio se ve de menos.
 *
 * Sin dependencias: se prueba con `node scripts/espiaMercado.js probar`.
 */

const ZONAS = {
  EC: 'America/Guayaquil',
  MX: 'America/Mexico_City',
  CO: 'America/Bogota',
  GT: 'America/Guatemala',
};

/** (stock_previo, stock_nuevo) → [ventas, reabastecido] */
function ventasDelTramo(stockPrevio, stockNuevo) {
  const nuevo = Number(stockNuevo) || 0;
  if (stockPrevio === null || stockPrevio === undefined) return [0, false];
  const previo = Number(stockPrevio) || 0;
  return [Math.max(0, previo - nuevo), nuevo > previo];
}

/**
 * pares = [[stock_previo, stock_nuevo], ...] de cada bodega/variación
 * → { ventas, reabastecimientos }
 */
function ventasProducto(pares) {
  let ventas = 0;
  let reab = 0;
  for (const [previo, nuevo] of pares) {
    const [v, r] = ventasDelTramo(previo, nuevo);
    ventas += v;
    if (r) reab += 1;
  }
  return { ventas, reabastecimientos: reab };
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona del país. */
function fechaLocal(instante, pais) {
  const zona = ZONAS[String(pais || '').toUpperCase()] || ZONAS.EC;
  const d = instante instanceof Date ? instante : new Date(instante);
  // en-CA da YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Fecha a la que se cargan las ventas: la local de la foto ANTERIOR. */
function fechaDeCarga(fotoAnterior, pais) {
  return fechaLocal(fotoAnterior, pais);
}

/**
 * Claves de stock de un producto tal como lo devuelve /products/index.
 * SIMPLE: warehouse_product[] con variacion_id = 0.
 * VARIABLE: variations[].warehouse_product_variation[] (o warehouse_product
 * dentro de cada variación, según la versión del panel).
 * → [{ warehouse_id, variacion_id, stock }]
 */
function clavesDeProducto(p) {
  const claves = new Map();
  const poner = (warehouseId, variacionId, stock) => {
    const w = Number(warehouseId);
    if (!Number.isFinite(w)) return;
    const v = Number(variacionId) || 0;
    const s = Math.max(0, Number(stock) || 0);
    const k = `${w}:${v}`;
    // Si la misma clave viene repetida, nos quedamos con la suma (es la misma
    // bodega con filas duplicadas en la respuesta).
    claves.set(k, {
      warehouse_id: w,
      variacion_id: v,
      stock: (claves.get(k)?.stock || 0) + s,
    });
  };

  const variaciones = Array.isArray(p?.variations) ? p.variations : [];
  if (variaciones.length) {
    for (const v of variaciones) {
      const lista =
        v?.warehouse_product_variation ||
        v?.warehouse_product ||
        v?.warehouses ||
        [];
      if (Array.isArray(lista) && lista.length) {
        for (const wp of lista) poner(wp?.warehouse_id, v?.id, wp?.stock);
      } else if (v?.stock !== undefined && v?.warehouse_id !== undefined) {
        poner(v.warehouse_id, v.id, v.stock);
      }
    }
  }
  if (!claves.size) {
    const lista = Array.isArray(p?.warehouse_product) ? p.warehouse_product : [];
    for (const wp of lista) poner(wp?.warehouse_id, 0, wp?.stock);
  }
  return [...claves.values()];
}

/**
 * Completa las claves que había antes y ya no vienen (Dropi omite las bodegas
 * en 0): se agregan con stock 0 para que cuenten como bajada.
 * previas: Map('w:v' → stock) ; nuevas: [{warehouse_id, variacion_id, stock}]
 */
function completarClaves(previas, nuevas) {
  const vistas = new Set(nuevas.map((c) => `${c.warehouse_id}:${c.variacion_id}`));
  const salida = [...nuevas];
  for (const [k, stock] of previas.entries()) {
    if (vistas.has(k)) continue;
    if (!(Number(stock) > 0)) continue; // ya estaba en 0: nada que bajar
    const [w, v] = k.split(':').map(Number);
    salida.push({ warehouse_id: w, variacion_id: v, stock: 0, _completada: true });
  }
  return salida;
}

/**
 * Suma de un producto en una pasada.
 * previas: Map('w:v' → stock) de la foto anterior (puede estar vacío).
 * nuevas: claves de la respuesta de hoy.
 * → { ventas, reabastecimientos, stockTotal, cambios:[{warehouse_id, variacion_id, stock}] }
 */
function resumirProducto(previas, nuevasCrudas) {
  const nuevas = completarClaves(previas, nuevasCrudas);
  const pares = [];
  const cambios = [];
  let stockTotal = 0;
  for (const c of nuevas) {
    const k = `${c.warehouse_id}:${c.variacion_id}`;
    const previo = previas.has(k) ? Number(previas.get(k)) : null;
    pares.push([previo, c.stock]);
    if (!c._completada) stockTotal += c.stock;
    if (previo === null || previo !== c.stock) cambios.push(c);
  }
  const { ventas, reabastecimientos } = ventasProducto(pares);
  return { ventas, reabastecimientos, stockTotal, cambios };
}

/** Nombre normalizado para agrupar «el mismo producto en otros proveedores». */
function normalizarNombre(nombre) {
  return String(nombre || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(
      /\b(el|la|los|las|de|del|con|para|por|y|en|un|una|x|pack|kit|nuevo|nueva|original|oferta|promo|envio|gratis)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Dos fichas son «iguales» si son del mismo país, distinto proveedor y comparten external_id o nombre normalizado. */
function sonIguales(a, b) {
  if (!a || !b) return false;
  if (String(a.pais) !== String(b.pais)) return false;
  if (Number(a.proveedor_id) === Number(b.proveedor_id)) return false;
  if (a.external_id && b.external_id && String(a.external_id) === String(b.external_id)) return true;
  const na = a.nombre_norm || normalizarNombre(a.nombre);
  const nb = b.nombre_norm || normalizarNombre(b.nombre);
  return Boolean(na) && na === nb;
}

/** Filtros del curso de Dropkiller (atajos de la pantalla y del reporte). */
const ATAJOS = {
  sin_escalar: { min_v7: 10, max_v7: 120, min_v30: 120, max_v30: 500, min_stock: 80 },
  nuevos_traccion: { creado_dias: 90, min_total: 100, max_total: 2000, max_reab: 5, min_stock: 100 },
  top_7d: { orden: 'v7' },
  todos: {},
};

module.exports = {
  ZONAS,
  ATAJOS,
  ventasDelTramo,
  ventasProducto,
  fechaLocal,
  fechaDeCarga,
  clavesDeProducto,
  completarClaves,
  resumirProducto,
  normalizarNombre,
  sonIguales,
};
