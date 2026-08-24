// utils/wizardProducto/componerMensajeInicial.js
// Compone el MENSAJE FIJO del wizard de producto: el texto que recibe el
// cliente que llega desde un anuncio, sin pasar por ningún modelo. Es puro
// (sin BD) a propósito: lo usan el endpoint de preview del front y el runtime
// del webhook, y los dos tienen que producir exactamente el mismo texto.
//
// Estructura (la misma que muestra el paso 4 del wizard):
//
//   {intro}                       ← 1-2 frases, generadas por IA y editables
//
//   💵 1 por $24,99               ← precio unitario SIEMPRE
//   🔥 2 por $34,99               ← solo combos válidos (cantidad>1 y precio>0)
//   🚚 Envío gratis y pagas al recibir
//
//   {pregunta_gancho}             ← por cantidad (físico) o por síntoma (salud)
//
// Los combos con casillas vacías se descartan: si no queda ninguno válido el
// mensaje ofrece solo la unidad y NUNCA menciona la palabra "combo" (ese es el
// bug que hacía decir al bot "el combo aún no está definido").

const MAX_IMAGENES = 3;
const MAX_VIDEOS = 1;

function aNumero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "$24,99" — formato que ya usa la spec y el catálogo en Ecuador. */
function fmtPrecio(v) {
  const n = aNumero(v);
  if (n === null) return '';
  // "$45" y no "$45,00": el ",00" solo mete ruido en el mensaje; los decimales
  // reales ($58,99) sí se conservan.
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2).replace('.', ',')}`;
}

function leerJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  try {
    const txt = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const v = JSON.parse(txt);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Combos que sí se pueden ofrecer: cantidad entera > 1 y precio > 0.
 * Se deduplican por cantidad y salen ordenados de menor a mayor.
 */
function combosValidos(combos_producto) {
  const lista = leerJson(combos_producto, []);
  if (!Array.isArray(lista)) return [];
  const porCantidad = new Map();
  for (const c of lista) {
    const cantidad = aNumero(c?.cantidad);
    const precio = aNumero(c?.precio ?? c?.valor);
    if (!cantidad || cantidad <= 1 || !Number.isInteger(cantidad)) continue;
    if (!precio || precio <= 0) continue;
    if (!porCantidad.has(cantidad)) porCantidad.set(cantidad, precio);
  }
  return [...porCantidad.entries()]
    .map(([cantidad, precio]) => ({ cantidad, precio }))
    .sort((a, b) => a.cantidad - b.cantidad);
}

const EMOJIS_COMBO = ['🔥', '💥', '🎁', '⭐'];

/** Líneas de precio: unidad primero y después los combos válidos. En un
 *  servicio no hay "unidades" ni combos: una sola línea de precio. */
function lineasPrecio(producto, tipo_venta) {
  const lineas = [];
  const unitario = aNumero(producto?.precio);
  if (tipo_venta === 'servicio') {
    if (unitario && unitario > 0) lineas.push(`💵 Precio: ${fmtPrecio(unitario)}`);
    return lineas;
  }
  if (unitario && unitario > 0) lineas.push(`💵 1 por ${fmtPrecio(unitario)}`);
  combosValidos(producto?.combos_producto).forEach((c, i) => {
    const emoji = EMOJIS_COMBO[Math.min(i, EMOJIS_COMBO.length - 1)];
    lineas.push(`${emoji} ${c.cantidad} por ${fmtPrecio(c.precio)}`);
  });
  return lineas;
}

/** Pregunta con la que cierra el mensaje cuando la IA no generó una. */
function preguntaGanchoPorDefecto(tipo_venta, producto) {
  if (tipo_venta === 'natural_salud') {
    return 'Para recomendarte bien: ¿cuál es tu molestia principal?';
  }
  if (tipo_venta === 'servicio') {
    return '¿Para qué fecha te gustaría agendarlo?';
  }
  const combos = combosValidos(producto?.combos_producto);
  if (combos.length) {
    const cantidades = [1, ...combos.map((c) => c.cantidad)];
    const ultimo = cantidades.pop();
    return `¿Te llevas ${cantidades.join(', ')} o ${ultimo} unidades?`;
  }
  return '¿Te lo enviamos a domicilio o prefieres retirarlo en agencia?';
}

function limpiarLinea(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * @param {object} producto fila de productos_chat_center (nombre, precio, combos_producto)
 * @param {object} wizard   { intro_mensaje, pregunta_gancho, linea_envio, tipo_venta }
 * @returns {string} el mensaje fijo, listo para enviar
 */
function componerMensajeInicial({ producto, wizard }) {
  const w = wizard || {};
  const partes = [];

  const intro = limpiarLinea(w.intro_mensaje);
  if (intro) partes.push(intro);

  const precios = lineasPrecio(producto, w.tipo_venta);
  const envio = limpiarLinea(
    w.linea_envio === undefined || w.linea_envio === null
      ? w.tipo_venta === 'servicio'
        ? ''
        : '🚚 Envío gratis y pagas al recibir'
      : w.linea_envio,
  );
  const bloquePrecios = [...precios, envio].filter(Boolean).join('\n');
  if (bloquePrecios) partes.push(bloquePrecios);

  const pregunta =
    limpiarLinea(w.pregunta_gancho) ||
    preguntaGanchoPorDefecto(w.tipo_venta, producto);
  if (pregunta) partes.push(pregunta);

  return partes.join('\n\n').trim();
}

/** Normaliza un item de media del wizard; devuelve null si no sirve. */
function normalizarItemMedia(m) {
  if (!m) return null;
  const url = limpiarLinea(m.url);
  if (!/^https?:\/\//i.test(url)) return null;
  const tipo = String(m.tipo || '').toLowerCase() === 'video' ? 'video' : 'image';
  return {
    tipo,
    url,
    origen: m.origen || 'subida',
    etiqueta: limpiarLinea(m.etiqueta) || null,
  };
}

/**
 * Aplica el tope del paquete: como máximo 3 imágenes y 1 video, en el orden
 * en que el negocio las dejó. Lo que sobra se descarta (no se reordena).
 */
function limitarMedia(lista) {
  const salida = [];
  let imgs = 0;
  let vids = 0;
  for (const raw of Array.isArray(lista) ? lista : []) {
    const m = normalizarItemMedia(raw);
    if (!m) continue;
    if (salida.some((s) => s.url === m.url)) continue;
    if (m.tipo === 'image') {
      if (imgs >= MAX_IMAGENES) continue;
      imgs += 1;
    } else {
      if (vids >= MAX_VIDEOS) continue;
      vids += 1;
    }
    salida.push(m);
  }
  return salida;
}

/** Foto y video del catálogo: SIEMPRE son las primeras piezas del paquete. */
function mediaFijaDelProducto(producto) {
  const fijos = [];
  if (producto?.imagen_url) {
    fijos.push({
      tipo: 'image',
      url: producto.imagen_url,
      origen: 'producto',
      etiqueta: 'Foto del producto',
    });
  }
  if (producto?.video_url) {
    fijos.push({
      tipo: 'video',
      url: producto.video_url,
      origen: 'producto',
      etiqueta: 'Video del producto',
    });
  }
  return fijos;
}

/**
 * El paquete de media del primer mensaje: la foto y el video del producto
 * (catálogo) van primero, y después las imágenes adicionales que el negocio
 * subió o generó en el wizard (media_json), hasta el tope de 3 imágenes y
 * 1 video. Una sola fuente para la foto: la del producto. Siempre salen
 * primero las imágenes y al final el video: el video pesa y tarda; las fotos
 * y el texto tienen que llegar antes.
 */
function paqueteMedia({ producto, wizard }) {
  const extras = leerJson(wizard?.media_json, []);
  const lista = limitarMedia([
    ...mediaFijaDelProducto(producto),
    ...(Array.isArray(extras) ? extras : []),
  ]);
  const imagenes = lista.filter((m) => m.tipo === 'image');
  const videos = lista.filter((m) => m.tipo === 'video');
  return { imagenes, videos, todas: [...imagenes, ...videos] };
}

module.exports = {
  MAX_IMAGENES,
  MAX_VIDEOS,
  aNumero,
  fmtPrecio,
  leerJson,
  combosValidos,
  lineasPrecio,
  preguntaGanchoPorDefecto,
  componerMensajeInicial,
  limitarMedia,
  mediaFijaDelProducto,
  paqueteMedia,
};
