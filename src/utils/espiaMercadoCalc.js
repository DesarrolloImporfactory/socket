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
 *  - No toda bajada es venta: los ajustes de inventario del proveedor se
 *    separan con `ventasCreibles` (ver más abajo) y no se suman.
 *
 * Límites conocidos: una venta tapada por una reposición en la misma ventana
 * no se ve; un pico real que multiplica de golpe lo que el producto venía
 * vendiendo se toma por ajuste ese día y entra desde el siguiente.
 *
 * Sin dependencias: se prueba con `node scripts/espiaMercado.js probar`.
 */

const ZONAS = {
  EC: 'America/Guayaquil',
  MX: 'America/Mexico_City',
  CO: 'America/Bogota',
  GT: 'America/Guatemala',
  PA: 'America/Panama',
  PE: 'America/Lima',
  CL: 'America/Santiago',
  AR: 'America/Argentina/Buenos_Aires',
  CR: 'America/Costa_Rica',
  PY: 'America/Asuncion',
  VE: 'America/Caracas',
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
 * Ventas creíbles vs. ajustes de stock (10-nov-2026).
 *
 * No toda baja de stock es una venta: el proveedor corrige su inventario, apaga
 * una variación, pasa mercadería de una bodega a otra o baja un stock «de
 * relleno» (49.167 → 10.000). Medido en Ecuador con 11 días de fotos: de 462.351
 * unidades «vendidas», 348.099 salían de 626 bajadas así (7 productos «vendían»
 * más de 35.000 unidades en un día). Un producto que vende 300 al día ya es de
 * los primeros del país.
 *
 * La regla compara cada bajada con lo que ESE producto venía vendiendo:
 *  - tope = el mayor de PISO y FACTOR × su mejor día creíble de los 14 anteriores.
 *    Un producto sin historia puede vender hasta PISO de una foto a otra; uno que
 *    ya vende 100 al día puede llegar a 250. Así un ganador crece sin que lo corten.
 *  - Si la bajada se lleva la mitad o más del stock de esa bodega/variación (o la
 *    deja en 0), el piso es PISO_VACIADO: vaciar de golpe es la firma del ajuste.
 *  - Lo que en la misma foto subió en otra bodega/variación del producto es un
 *    traslado, no una venta: se descuenta.
 *  - Si después de eso el conjunto todavía pasa del tope, es un ajuste repartido
 *    entre muchas variaciones: no cuenta nada.
 * Lo que no pasa la regla no se suma como venta (se devuelve aparte en `ajuste`).
 *
 * bajadas: [{ d, prev }] (unidades que bajó la clave y stock que tenía)
 * subida: unidades que subieron otras claves del producto en la misma foto
 * mayorDia: mejor día creíble del producto en los 14 días anteriores (0 = sin historia)
 * → { ventas, ajuste }
 */
const AJUSTE = { PISO: 40, PISO_VACIADO: 20, FACTOR: 2.5, DIAS_REFERENCIA: 14 };

function ventasCreibles(bajadas, subida = 0, mayorDia = 0) {
  const mayor = Math.max(0, Number(mayorDia) || 0);
  const tope = Math.max(AJUSTE.PISO, AJUSTE.FACTOR * mayor);
  const topeVaciado = Math.max(AJUSTE.PISO_VACIADO, AJUSTE.FACTOR * mayor);
  let ventas = 0;
  let ajuste = 0;
  for (const b of bajadas) {
    const d = Number(b.d) || 0;
    if (d <= 0) continue;
    const vacia = d >= (Number(b.prev) || 0) * 0.5;
    if (d > (vacia ? topeVaciado : tope)) ajuste += d;
    else ventas += d;
  }
  const sube = Math.max(0, Number(subida) || 0);
  if (sube > 0 && ventas > 0) {
    const traslado = Math.min(ventas, sube);
    ventas -= traslado;
    ajuste += traslado;
  }
  if (ventas > tope) {
    ajuste += ventas;
    ventas = 0;
  }
  return { ventas, ajuste };
}

/**
 * Suma de un producto en una pasada.
 * previas: Map('w:v' → stock) de la foto anterior (puede estar vacío).
 * nuevas: claves de la respuesta de hoy.
 * mayorDia: mejor día creíble del producto en los 14 días anteriores (ver ventasCreibles).
 * → { ventas, ajuste, reabastecimientos, stockTotal, cambios:[{warehouse_id, variacion_id, stock}] }
 *   ventas = solo lo creíble; ajuste = unidades que bajaron y no cuentan como venta.
 */
function resumirProducto(previas, nuevasCrudas, mayorDia = 0) {
  const nuevas = completarClaves(previas, nuevasCrudas);
  const cambios = [];
  const bajadas = [];
  let stockTotal = 0;
  let subida = 0;
  let reabastecimientos = 0;
  for (const c of nuevas) {
    const k = `${c.warehouse_id}:${c.variacion_id}`;
    const previo = previas.has(k) ? Number(previas.get(k)) : null;
    if (!c._completada) stockTotal += c.stock;
    if (previo === null || previo !== c.stock) cambios.push(c);
    if (previo === null) continue; // primera vez que se ve la clave: no cuenta nada
    if (c.stock < previo) bajadas.push({ d: previo - c.stock, prev: previo });
    else if (c.stock > previo) {
      subida += c.stock - previo;
      reabastecimientos += 1;
    }
  }
  const { ventas, ajuste } = ventasCreibles(bajadas, subida, mayorDia);
  return { ventas, ajuste, reabastecimientos, stockTotal, cambios };
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
  AJUSTE,
  ventasCreibles,
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
