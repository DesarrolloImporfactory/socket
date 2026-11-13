// services/remarketing_producto.service.js
// Remarketing por producto (menú Productos → Remarketing).
//
// El negocio configura, por producto, el recordatorio que recibe el cliente
// que llegó por un anuncio y no cerró: texto + foto + botones («⭐ Ver
// opiniones», «✅ Sí, lo quiero»), qué se manda al tocar cada botón y en
// cuántos pasos. Los productos sin configuración siguen con el remarketing
// de la columna (configuracion_remarketing), como siempre.
//
// Sale SOLO dentro de la ventana de 24 h: texto + botones interactivos, sin
// plantilla de Meta ni costo por plantilla. Si la ventana se cerró, el cron
// cae a la plantilla de la columna (la fila de la cola lleva la plantilla
// de respaldo). Hoy el 69 % de los remarketings salen dentro de la ventana.
//
// Dónde entra cada pieza:
//  - kanban_ia.programarRemarketingKanban → remarketingDelProductoEnJuego +
//    programarPasoProducto (en vez de la columna) si el producto en juego
//    tiene remarketing activo.
//  - cron/remarketing.js → enviarPasoProducto (intento 0) y
//    programarSiguientePasoProducto (encadenado).
//  - webhook WhatsApp → interpretarBotonProducto + atenderBotonProducto
//    (igual que el colchón: antes de la IA) y registrarRespuestaProducto.
const axios = require('axios');
const { db } = require('../database/config');
const MensajesClientes = require('../models/mensaje_cliente.model');
const {
  resolverProductoAnuncio,
} = require('../utils/webhook_whatsapp/buscar_producto_referral');
const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');
const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');
const {
  uploadToUploader,
  uploadVideoToVideoAPI,
  getConfigFromDB,
} = require('../utils/whatsappTemplate.helpers');
const {
  combosValidos,
  aNumero,
  fmtPrecio: fmtPrecioCatalogo,
} = require('../utils/wizardProducto/componerMensajeInicial');

const T = db.QueryTypes;

/* ── Piloto ─────────────────────────────────────────────────────────────
   Como Campañas: lista de cuentas; vacía = todas. Abierto a todas las
   cuentas desde el 05-11-2026 (el piloto fue 10, 610 y 822). Si hiciera
   falta volver a acotarlo, REMARKETING_PRODUCTO_PILOTO=10,610 en el .env.
   El front tiene la misma lista en pages/remarketingProducto. */
const PILOTO = String(process.env.REMARKETING_PRODUCTO_PILOTO ?? '')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const cuentaEnPiloto = (id_configuracion) =>
  !PILOTO.length || PILOTO.includes(Number(id_configuracion));

const COLUMNA = 'contacto_inicial';
const RESPONSABLE = 'cron_remarketing_producto';
const RESPONSABLE_BLOQUE = 'IA_remarketing_producto';
const PREFIJO_BOTON = 'rmkp_';
const MAX_PASOS = 3;
const MAX_BOTONES = 3;
const MAX_TITULO = 20; // límite de WhatsApp para botones reply
const MAX_CUERPO = 1024; // límite del body interactivo
const MAX_ITEMS_BLOQUE = 10;
const VENTANA_RESPUESTA_H = 72;

const BOTONES_DEFECTO = [
  { clave: 'opiniones', titulo: '⭐ Ver opiniones', accion: 'bloque' },
  { clave: 'quiero', titulo: '✅ Sí, lo quiero', accion: 'cerrar' },
];

/* Ventana de 24 h de WhatsApp: un mensaje libre (texto + botones) solo sale
   si el cliente escribió en las últimas 24 h. Los pasos se encadenan SIN
   respuesta del cliente, así que lo que manda es el tiempo ACUMULADO desde su
   último mensaje. Un paso que cae fuera lleva su propia plantilla aprobada de
   Meta (`plantilla` en el paso); si el cliente vuelve a escribir y la ventana
   se reabre, el cron intenta primero el mensaje con botones si lo hay. */
const LIMITE_VENTANA_MIN = 24 * 60;
const acumuladoHasta = (pasos, idx) =>
  pasos.slice(0, idx + 1).reduce((t, p) => t + (Number(p?.minutos) || 0), 0);

const REMATE_DEFECTO = '¿Te gustaría pedir 1, 2 o 3 unidades? 😊';

/* Descuento de recuperación (botón «🎁 Quiero mi 10% OFF», pensado para el
   último recordatorio). El porcentaje lo fija el dueño por botón; al tocarlo
   queda anotado para ESE cliente (evento 'descuento') y vale
   DESCUENTO_VIGENCIA_H horas o hasta que se cree el pedido (evento
   'descuento_usado'). */
const DESCUENTO_PCT_DEFECTO = 10;
const DESCUENTO_PCT_MAX = 90;
const DESCUENTO_VIGENCIA_H = 72;
const pctValido = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return DESCUENTO_PCT_DEFECTO;
  return Math.min(n, DESCUENTO_PCT_MAX);
};

/* Botones sugeridos para cada recordatorio: misma intención (ver opiniones /
   pedir), otra forma de decirlo para que la secuencia no se lea repetida.
   Las claves 'opiniones' y 'quiero' se mantienen en los tres porque las
   métricas (metricasPorProducto) cuentan por clave. */
const BOTONES_DEFECTO_POR_PASO = [
  BOTONES_DEFECTO,
  [
    { clave: 'opiniones', titulo: '👀 Ver qué opinan', accion: 'bloque' },
    { clave: 'quiero', titulo: '🛒 Pedirlo ahora', accion: 'cerrar' },
  ],
  // Último recordatorio: el descuento es el empujón para recuperarlo.
  [
    { clave: 'opiniones', titulo: '⭐ Opiniones reales', accion: 'bloque' },
    {
      clave: 'descuento',
      titulo: `🎁 Quiero mi ${DESCUENTO_PCT_DEFECTO}% OFF`,
      accion: 'descuento',
      descuento_pct: DESCUENTO_PCT_DEFECTO,
    },
  ],
];

/* Cada recordatorio lleva SUS botones (texto y acción, `pasos[i].botones`,
   desde el 06-11-2026; antes había una sola lista por producto y los
   recordatorios 2 y 3 solo cambiaban el texto con `botones_titulos`, así que
   al editar el 2 se veía y se pisaba lo del 1). El CONTENIDO (bloques) es
   uno por producto, por clave de botón: toque el botón del recordatorio que
   toque, «ver opiniones» manda las mismas capturas (Daniel, 06-11).
   1 h → 5 h → 8 h suman 14 h, todos dentro de la ventana. */
const PASOS_DEFECTO = [
  {
    minutos: 60,
    mensaje:
      'Hola {{nombre}} 👋 Vi que te interesó *{{producto}}* y quedó pendiente. ¿Te ayudo a completar tu pedido? Para tu tranquilidad, aquí puedes ver más 👇',
    con_imagen: true,
    con_botones: true,
    botones: BOTONES_DEFECTO_POR_PASO[0],
  },
  {
    minutos: 300,
    mensaje:
      '{{nombre}}, sigo por aquí 🙂 *{{producto}}* todavía está disponible. ¿Te quedó alguna duda? Te la resuelvo ahora mismo 👇',
    con_imagen: false,
    con_botones: true,
    // Por defecto el 2 lleva las ofertas del producto en los botones («1 por
    // $X», «2 por $Y»…): un toque y el cliente ya eligió cantidad. Los
    // botones propios quedan guardados por si el dueño cambia de modo.
    botones_modo: 'ofertas',
    botones: BOTONES_DEFECTO_POR_PASO[1],
  },
  {
    minutos: 480,
    mensaje:
      'Última llamada, {{nombre}} 🙌 Para que no te quedes sin *{{producto}}*, hoy te lo dejo con un descuento especial. ¿Lo aseguramos? 👇',
    con_imagen: true,
    con_botones: true,
    botones: BOTONES_DEFECTO_POR_PASO[2],
  },
];

const copiaJson = (v) => JSON.parse(JSON.stringify(v));

/* Compatibilidad con lo guardado antes del 06-11-2026: un paso sin `botones`
   usa los del producto (config.botones) con el texto propio del paso
   (`botones_titulos`). Así una fila vieja sigue mandando lo mismo. */
function botonesDe(config, paso) {
  if (Array.isArray(paso?.botones)) return paso.botones.slice(0, MAX_BOTONES);
  const titulos = paso?.botones_titulos && typeof paso.botones_titulos === 'object' ? paso.botones_titulos : {};
  return (config?.botones || []).slice(0, MAX_BOTONES).map((b) => {
    const t = String(titulos[b.clave] || '').trim();
    return t ? { ...b, titulo: t } : b;
  });
}

/* ── Ofertas del producto en los botones ──────────────────────────────────
   `pasos[i].botones_modo = 'ofertas'`: los botones del recordatorio NO se
   escriben a mano, son las ofertas del producto tal como están en su ficha
   (precio unitario + combos_producto, lo mismo que arma el mensaje fijo:
   «1 por $24,99», «2 por $34,99»). Se calculan AL ENVIAR, así un cambio de
   precio en el producto se refleja solo, sin volver a guardar el remarketing.
   Máximo 3 (límite de WhatsApp): la unidad y los dos primeros combos. */
const EMOJI_OFERTA = ['💵', '🔥', '🎁'];
function ofertasDe(producto) {
  const lista = [];
  const unitario = aNumero(producto?.precio);
  if (unitario && unitario > 0) lista.push({ cantidad: 1, precio: unitario });
  for (const c of combosValidos(producto?.combos_producto)) lista.push(c);
  return lista.slice(0, MAX_BOTONES).map((o, i) => {
    const base = `${o.cantidad} por ${fmtPrecioCatalogo(o.precio)}`;
    const conEmoji = `${EMOJI_OFERTA[i]} ${base}`;
    const titulo =
      [...conEmoji].length <= MAX_TITULO
        ? conEmoji
        : [...base].slice(0, MAX_TITULO).join('');
    return {
      clave: `oferta_${o.cantidad}`,
      titulo,
      accion: 'oferta',
      cantidad: o.cantidad,
      precio: o.precio,
    };
  });
}

/* Botones que de verdad salen en el envío del paso: las ofertas del producto
   si el paso está en ese modo (y el producto tiene precio); si no, los suyos. */
function botonesDelEnvio(config, paso, producto) {
  if (!paso || paso.con_botones === false) return [];
  if (paso.botones_modo === 'ofertas') {
    const ofertas = ofertasDe(producto);
    if (ofertas.length) return ofertas;
  }
  return botonesDe(config, paso);
}

const urlValida = (v) =>
  /^https?:\/\//i.test(String(v || '')) ? String(v).trim().slice(0, 1000) : null;

/* Foto de cabecera del paso: la suya (pasos[i].imagen_url, desde el
   06-11-2026), si no la del producto guardada antes (config.imagen_url, una
   sola para todos) y si no la foto del producto. null = sin foto propia. */
function imagenDe(config, paso) {
  if (paso && 'imagen_url' in paso) return urlValida(paso.imagen_url);
  return urlValida(config?.imagen_url);
}

/* Pasos con botones y foto propios garantizados (hidrata los viejos). */
function pasosConPropios(config) {
  return (config?.pasos || []).map((p) => {
    const { botones_titulos, ...resto } = p || {};
    return { ...resto, botones: copiaJson(botonesDe(config, p)), imagen_url: imagenDe(config, p) };
  });
}

/* Botones «manda contenido» de todos los pasos, uno por clave: son las
   entradas que el contenido del producto tiene que cubrir. */
function botonesBloqueDe(pasos) {
  const vistos = new Map();
  for (const p of pasos) {
    for (const b of p?.botones || []) {
      if (b.accion === 'bloque' && !vistos.has(b.clave)) vistos.set(b.clave, b);
    }
  }
  return [...vistos.values()];
}

/* ── Utilidades ───────────────────────────────────────────────────────── */

const leerJson = (v, porDefecto) => {
  if (v == null) return porDefecto;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return porDefecto;
  }
};

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);

const fmtPrecio = (p) => {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `$${n.toFixed(2).replace(/\.00$/, '')}`;
};

function rellenar(texto, { nombre, producto, precio }) {
  return String(texto || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, nombre || '')
    .replace(/\{\{\s*producto\s*\}\}/gi, producto || '')
    .replace(/\{\{\s*precio\s*\}\}/gi, precio || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

const primerNombre = (s) =>
  String(s || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^\p{L}\p{N}'-]/gu, '');

const error = (mensaje, statusCode = 400, codigo = null) => {
  const e = new Error(mensaje);
  e.statusCode = statusCode;
  e.codigo = codigo;
  return e;
};

/* ── Normalización de la configuración que manda el front ─────────────── */

const HEADER_MEDIA = ['IMAGE', 'VIDEO', 'DOCUMENT'];

function normalizarPlantilla(pl) {
  const nombre = String(pl?.nombre_template || '').trim();
  if (!nombre) return null;
  if (!/^[a-z0-9_]{1,512}$/i.test(nombre)) throw error(`Nombre de plantilla inválido: ${nombre}`);
  const header_format = String(pl?.header_format || '').toUpperCase() || null;
  const header_media_url = /^https?:\/\//i.test(String(pl?.header_media_url || ''))
    ? String(pl.header_media_url).trim().slice(0, 1000)
    : null;
  return {
    nombre_template: nombre,
    language_code: String(pl?.language_code || 'es').slice(0, 10),
    header_format: HEADER_MEDIA.includes(header_format) ? header_format : null,
    header_media_url: HEADER_MEDIA.includes(header_format) ? header_media_url : null,
  };
}

/**
 * Pasos tal como los manda el front, cada uno con SUS botones. `body` es la
 * configuración completa: si un paso llega sin `botones` (front anterior al
 * 06-11-2026) se toman los del producto con el texto propio del paso, igual
 * que se leían antes. Los botones solo se exigen completos en los pasos que
 * de verdad los mandan (con botones y dentro de las 24 h); en los demás se
 * guardan como están, sin vacíos, para no perder lo configurado si el dueño
 * apaga «Con botones» y lo vuelve a prender.
 */
function normalizarPasos(pasos, body = {}) {
  const lista = Array.isArray(pasos) ? pasos : [];
  const recortada = lista.slice(0, MAX_PASOS);
  const out = recortada.map((p, i) => {
    const etiqueta = `recordatorio ${i + 1}`;
    const minutos = Math.round(Number(p?.minutos));
    if (!Number.isFinite(minutos) || minutos < 5 || minutos > 3 * 1440) {
      throw error(`El ${etiqueta} necesita un tiempo entre 5 minutos y 3 días`);
    }
    const mensaje = String(p?.mensaje || '').trim();
    if (mensaje.length > MAX_CUERPO) {
      throw error(`El mensaje del ${etiqueta} supera ${MAX_CUERPO} caracteres`);
    }
    const plantilla = normalizarPlantilla(p?.plantilla);
    const fueraDeVentana = acumuladoHasta(recortada, i) > LIMITE_VENTANA_MIN;
    if (fueraDeVentana && !plantilla) {
      throw error(
        `El ${etiqueta} llegaría más de 24 h después del último mensaje del cliente; ` +
          'WhatsApp solo permite plantillas aprobadas ahí. Elige una plantilla para ese recordatorio o acorta los tiempos.',
      );
    }
    if (!fueraDeVentana && !mensaje) throw error(`El ${etiqueta} no tiene mensaje`);
    const con_botones = p?.con_botones !== false && p?.con_botones !== 0;
    const botones_modo = p?.botones_modo === 'ofertas' ? 'ofertas' : 'propios';
    // En modo ofertas los botones salen del producto: los propios se guardan
    // sin exigirlos, por si el dueño vuelve a «botones propios».
    const usaBotones = con_botones && !fueraDeVentana && botones_modo !== 'ofertas';
    const botones = normalizarBotones(botonesDe(body, p), { exigir: usaBotones, etiqueta });
    return {
      minutos,
      mensaje,
      con_imagen: p?.con_imagen !== false && p?.con_imagen !== 0,
      imagen_url: imagenDe(body, p),
      con_botones,
      botones_modo,
      botones,
      ...(plantilla ? { plantilla } : {}),
    };
  });
  if (!out.length) throw error('Configura al menos un recordatorio');
  return out;
}

/**
 * Cuadre de las plantillas elegidas por paso contra la definición real en
 * Meta (cacheada en whatsapp.service). En contacto_inicial no hay pedido ni
 * datos con qué llenar {{n}}, así que una plantilla con variables moriría en
 * el cron con (#132000); mejor rechazarla al guardar. Si Meta no responde se
 * deja pasar: el cron hace el mismo cuadre antes de enviar.
 */
async function validarPlantillasDePasos(id_configuracion, pasos) {
  const conPlantilla = pasos.filter((p) => p.plantilla?.nombre_template);
  if (!conPlantilla.length) return;
  let cfg;
  try {
    cfg = await getConfigFromDB(id_configuracion);
  } catch {
    return;
  }
  if (!cfg?.ACCESS_TOKEN || !cfg?.WABA_ID) return;
  const { obtenerTextoPlantilla } = require('./whatsapp.service');
  for (const p of conPlantilla) {
    const nombre = p.plantilla.nombre_template;
    let def;
    try {
      def = await obtenerTextoPlantilla(nombre, cfg.ACCESS_TOKEN, cfg.WABA_ID);
    } catch {
      continue;
    }
    if (!def?.text) throw error(`La plantilla «${nombre}» no existe en tu cuenta de WhatsApp.`);
    if (def.status && String(def.status).toUpperCase() !== 'APPROVED') {
      throw error(`La plantilla «${nombre}» todavía no está aprobada por Meta (${def.status}).`);
    }
    if (/\{\{\d+\}\}/.test(def.text) || /\{\{\d+\}\}/.test(def.header?.text || '')) {
      throw error(
        `La plantilla «${nombre}» tiene variables y en este punto no hay datos con qué llenarlas. Usa una plantilla sin variables.`,
      );
    }
    if ((def.buttons || []).some((b) => b?.url && /\{\{\d+\}\}/.test(b.url))) {
      throw error(`La plantilla «${nombre}» tiene un botón con URL variable; usa una con URL fija o sin botón.`);
    }
    const fmt = String(def.header?.format || '').toUpperCase();
    if (HEADER_MEDIA.includes(fmt)) {
      p.plantilla.header_format = fmt;
      p.plantilla.header_media_url =
        p.plantilla.header_media_url || def.header?.media_url || null;
    } else {
      p.plantilla.header_format = null;
      p.plantilla.header_media_url = null;
    }
    if (def.language) p.plantilla.language_code = def.language;
  }
}

/* `exigir`: el paso manda estos botones de verdad → texto obligatorio y
   límite de WhatsApp; sin botones → BOTONES_DEFECTO. Sin exigir (paso de
   plantilla o con los botones apagados) se guardan los que tengan texto,
   recortados, y puede quedar vacío. */
function normalizarBotones(botones, { exigir = true, etiqueta = '' } = {}) {
  const donde = etiqueta ? ` del ${etiqueta}` : '';
  let lista = Array.isArray(botones) ? botones : [];
  if (!exigir) lista = lista.filter((b) => String(b?.titulo || '').trim());
  else if (!lista.length) lista = BOTONES_DEFECTO;
  const vistos = new Set();
  const out = lista.slice(0, MAX_BOTONES).map((b, i) => {
    let titulo = String(b?.titulo || '').trim();
    if (!titulo) throw error(`El botón ${i + 1}${donde} no tiene texto`);
    if ([...titulo].length > MAX_TITULO) {
      if (exigir) throw error(`El botón «${titulo}»${donde} supera ${MAX_TITULO} caracteres (límite de WhatsApp)`);
      titulo = [...titulo].slice(0, MAX_TITULO).join('');
    }
    // Tres acciones: mandar contenido, que el bot siga cerrando la venta
    // como siempre (respuestas rápidas del wizard → IA) o cerrar CON
    // descuento (el bot lo aplica al total del pedido). 'ia' quedó de la
    // primera versión y se trata como 'cerrar'.
    const accion = ['bloque', 'descuento'].includes(b?.accion) ? b.accion : 'cerrar';
    let clave = slug(b?.clave) || slug(titulo) || `boton_${i + 1}`;
    // 'oferta_N' está reservada para los botones automáticos de ofertas.
    if (/^oferta_[0-9]+$/.test(clave)) clave = `boton_${i + 1}`;
    if (vistos.has(clave)) clave = `${clave}_${i + 1}`;
    vistos.add(clave);
    return accion === 'descuento'
      ? { clave, titulo, accion, descuento_pct: pctValido(b?.descuento_pct) }
      : { clave, titulo, accion };
  });
  return out;
}

/* Contenido de los botones «manda contenido». La pregunta de cierre
   (remate) se guarda tal como la escribió el dueño: vacía queda null (no se
   manda nada después del último archivo); solo un bloque que no llega con
   el campo (front viejo) recibe la sugerida. */
function normalizarBloques(bloques, botones, { exigir = true, etiqueta = '' } = {}) {
  const donde = etiqueta ? ` (${etiqueta})` : '';
  const src = bloques && typeof bloques === 'object' ? bloques : {};
  const out = {};
  for (const b of botones) {
    if (b.accion !== 'bloque') continue;
    const bl = src[b.clave] && typeof src[b.clave] === 'object' ? src[b.clave] : {};
    const items = (Array.isArray(bl.items) ? bl.items : [])
      .slice(0, MAX_ITEMS_BLOQUE)
      .map((it) => {
        const tipo = ['image', 'video', 'document', 'text'].includes(it?.tipo) ? it.tipo : 'text';
        const url = String(it?.url || '').trim();
        const texto = String(it?.texto || '').trim();
        if (tipo !== 'text' && !/^https?:\/\//i.test(url)) {
          if (!exigir) return null;
          throw error(`Un elemento de «${b.titulo}»${donde} no tiene archivo`);
        }
        if (tipo === 'text' && !texto) {
          if (!exigir) return null;
          throw error(`Un texto de «${b.titulo}»${donde} está vacío`);
        }
        const retraso = Math.round(Number(it?.retraso_seg));
        return {
          tipo,
          url: tipo === 'text' ? null : url,
          texto: texto.slice(0, 4000) || null,
          retraso_seg: Number.isFinite(retraso) ? Math.min(Math.max(retraso, 0), 30) : 2,
        };
      })
      .filter(Boolean);
    out[b.clave] = {
      items,
      remate: String(bl.remate ?? REMATE_DEFECTO).trim().slice(0, MAX_CUERPO) || null,
    };
  }
  return out;
}

/* La columna `botones` de la tabla queda como espejo del recordatorio 1 (es
   NOT NULL y /listar la muestra); lo que manda al enviar son los de cada
   paso. `bloques` es el contenido del producto, cubriendo las claves de los
   botones «manda contenido» de todos los pasos que de verdad los mandan. */
function normalizarConfig(body) {
  const pasos = normalizarPasos(body?.pasos, body || {});
  const primero = pasos[0];
  const mandan = pasos.filter(
    (p, i) =>
      p.con_botones &&
      p.botones_modo !== 'ofertas' &&
      acumuladoHasta(pasos, i) <= LIMITE_VENTANA_MIN,
  );
  return {
    activo: body?.activo === false || body?.activo === 0 ? 0 : 1,
    pasos,
    // Espejo del paso 1; la foto que manda es la de cada paso.
    imagen_url: primero.imagen_url || null,
    botones: primero.botones.length ? primero.botones : BOTONES_DEFECTO,
    bloques: normalizarBloques(body?.bloques, botonesBloqueDe(mandan)),
    estado_destino: body?.estado_destino ? String(body.estado_destino).trim().slice(0, 100) : null,
  };
}

function filaAConfig(fila) {
  if (!fila) return null;
  const base = {
    id: fila.id,
    id_configuracion: fila.id_configuracion,
    id_producto: fila.id_producto,
    activo: Number(fila.activo) === 1,
    pasos: leerJson(fila.pasos, []),
    imagen_url: fila.imagen_url || null,
    botones: leerJson(fila.botones, BOTONES_DEFECTO),
    bloques: leerJson(fila.bloques, {}),
    estado_destino: fila.estado_destino || null,
    created_at: fila.created_at,
    updated_at: fila.updated_at,
  };
  // Siempre con botones por paso, también en filas guardadas antes del
  // 06-11-2026 (reciben los del producto, que es lo que mandaban).
  return { ...base, pasos: pasosConPropios(base) };
}

/* ── Lecturas ─────────────────────────────────────────────────────────── */

async function productoDe(id_configuracion, id_producto) {
  const [p] = await db.query(
    `SELECT id, nombre, precio, combos_producto, imagen_url, video_url, descripcion,
            documento_url, documento_nombre
       FROM productos_chat_center
      WHERE id = ? AND id_configuracion = ? AND eliminado = 0 LIMIT 1`,
    { replacements: [id_producto, id_configuracion], type: T.SELECT },
  );
  return p || null;
}

async function cargarConfig(id_remarketing_producto) {
  const [fila] = await db.query(
    `SELECT * FROM remarketing_producto WHERE id = ? LIMIT 1`,
    { replacements: [id_remarketing_producto], type: T.SELECT },
  );
  return filaAConfig(fila);
}

async function configDeProducto(id_configuracion, id_producto) {
  const [fila] = await db.query(
    `SELECT * FROM remarketing_producto
      WHERE id_configuracion = ? AND id_producto = ? LIMIT 1`,
    { replacements: [id_configuracion, id_producto], type: T.SELECT },
  );
  return filaAConfig(fila);
}

/** Propuesta inicial para un producto sin configuración. */
function configPorDefecto(producto, columnas = []) {
  return {
    id: null,
    id_producto: producto.id,
    activo: true,
    pasos: copiaJson(PASOS_DEFECTO),
    imagen_url: null, // null = foto del producto
    botones: copiaJson(PASOS_DEFECTO[0].botones),
    bloques: { opiniones: { items: [], remate: REMATE_DEFECTO } },
    // Tras el último recordatorio el cliente pasa a Remarketing (si la
    // columna existe): así no choca con el flujo de Contacto inicial.
    estado_destino: columnas.some((c) => c.estado_db === 'remarketing') ? 'remarketing' : null,
  };
}

/** Columnas del tablero principal, para el select «mover a». */
async function columnasDe(id_configuracion) {
  return db.query(
    `SELECT estado_db, nombre FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 AND id_tablero IS NULL
      ORDER BY orden, id`,
    { replacements: [id_configuracion], type: T.SELECT },
  ).catch(() => []);
}

/* Columnas del tablero que significan «ya hay pedido» (las mismas del
   tablero de salud del bot, botMetricas.service). */
const ESTADOS_COMPRA = [
  'generar_guia',
  'guia_generada',
  'guia_creada',
  'en_transito',
  'entregada',
  'retiro_agencia',
  'novedad',
  'devolucion',
];

/**
 * «Compraron»: clientes que recibieron un recordatorio del producto en el
 * periodo y DESPUÉS terminaron con pedido. No hay historial de cambios de
 * columna, así que se usan las dos señales que existen:
 *  - el cliente está hoy en una columna de pedido (el recordatorio solo sale
 *    en Contacto inicial, así que llegó ahí después de recibirlo), o
 *  - el bot le creó la orden en Dropi después del primer recordatorio
 *    (dropi_auto_ordenes_log), aunque luego haya pasado a otra columna.
 * Cuenta al cliente aunque no haya respondido al recordatorio con un mensaje
 * medible (p. ej. compró hablando con un asesor).
 * @returns {Promise<Map<number, number>>} id_producto → clientes
 */
async function comprasTrasRecordatorio(id_configuracion, dias) {
  const out = new Map();
  try {
    const filas = await db.query(
      `SELECT e.id_producto, COUNT(DISTINCT e.id_cliente_chat_center) AS compraron
         FROM (SELECT id_producto, id_cliente_chat_center, MIN(created_at) AS primer_envio
                 FROM remarketing_producto_eventos
                WHERE id_configuracion = ? AND evento = 'enviado'
                  AND created_at >= DATE_SUB(NOW(), INTERVAL ${dias} DAY)
                GROUP BY id_producto, id_cliente_chat_center) e
         JOIN clientes_chat_center c ON c.id = e.id_cliente_chat_center
        WHERE c.estado_contacto IN (${ESTADOS_COMPRA.map(() => '?').join(',')})
           OR EXISTS (SELECT 1 FROM dropi_auto_ordenes_log al
                       WHERE al.id_configuracion = ? AND al.id_cliente = e.id_cliente_chat_center
                         AND al.resultado IN ('creada', 'actualizada')
                         AND al.created_at >= e.primer_envio)
        GROUP BY e.id_producto`,
      { replacements: [id_configuracion, ...ESTADOS_COMPRA, id_configuracion], type: T.SELECT },
    );
    for (const f of filas) out.set(Number(f.id_producto), Number(f.compraron || 0));
  } catch (e) {
    console.warn('[remarketing_producto] compras:', e.message);
  }
  return out;
}

async function metricasPorProducto(id_configuracion, dias = 30) {
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const filas = await db.query(
    `SELECT id_producto,
            SUM(evento = 'enviado') AS enviados,
            COUNT(DISTINCT CASE WHEN evento = 'enviado' THEN id_cliente_chat_center END) AS clientes,
            COUNT(DISTINCT CASE WHEN evento IN ('respondio','boton') THEN id_cliente_chat_center END) AS respondieron,
            COUNT(DISTINCT CASE WHEN evento = 'boton' AND detalle = 'opiniones' THEN id_cliente_chat_center END) AS opiniones,
            COUNT(DISTINCT CASE WHEN evento = 'boton' AND (detalle = 'quiero' OR detalle LIKE 'oferta\\_%') THEN id_cliente_chat_center END) AS quiero,
            COUNT(DISTINCT CASE WHEN evento = 'descuento' THEN id_cliente_chat_center END) AS descuento,
            COUNT(DISTINCT CASE WHEN evento IN ('cierre_ia','cierre_flujo') THEN id_cliente_chat_center END) AS cierres,
            MAX(CASE WHEN evento = 'enviado' THEN created_at END) AS ultimo_envio
       FROM remarketing_producto_eventos
      WHERE id_configuracion = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ${d} DAY)
      GROUP BY id_producto`,
    { replacements: [id_configuracion], type: T.SELECT },
  );
  const compras = await comprasTrasRecordatorio(id_configuracion, d);
  const out = new Map();
  for (const f of filas) {
    out.set(Number(f.id_producto), {
      compraron: compras.get(Number(f.id_producto)) || 0,
      descuento: Number(f.descuento || 0),
      enviados: Number(f.enviados || 0),
      clientes: Number(f.clientes || 0),
      respondieron: Number(f.respondieron || 0),
      opiniones: Number(f.opiniones || 0),
      quiero: Number(f.quiero || 0),
      cierres: Number(f.cierres || 0),
      ultimo_envio: f.ultimo_envio,
    });
  }
  return out;
}

/** Lista de productos de la cuenta con su estado de remarketing y métricas. */
async function listar(id_configuracion, { dias = 30 } = {}) {
  const [productos, configs, metricas, columnas] = await Promise.all([
    db.query(
      `SELECT p.id, p.nombre, p.precio, p.imagen_url,
              (SELECT COUNT(*) FROM anuncios_producto ap
                WHERE ap.id_configuracion = p.id_configuracion AND ap.id_producto = p.id) AS anuncios,
              (SELECT w.activo FROM productos_wizard w WHERE w.id_producto = p.id LIMIT 1) AS wizard_activo,
              (SELECT w.usar_flujo_pasos FROM productos_wizard w WHERE w.id_producto = p.id LIMIT 1) AS wizard_flujo
         FROM productos_chat_center p
        WHERE p.id_configuracion = ? AND p.eliminado = 0
        ORDER BY p.nombre`,
      { replacements: [id_configuracion], type: T.SELECT },
    ),
    db.query(
      `SELECT id, id_producto, activo, pasos, botones, updated_at
         FROM remarketing_producto WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: T.SELECT },
    ),
    metricasPorProducto(id_configuracion, dias),
    columnasDe(id_configuracion),
  ]);
  const porProducto = new Map(configs.map((c) => [Number(c.id_producto), c]));
  const [defecto] = await db.query(
    `SELECT COUNT(*) AS n FROM configuracion_remarketing
      WHERE id_configuracion = ? AND estado_contacto = ? AND activo = 1`,
    { replacements: [id_configuracion, COLUMNA], type: T.SELECT },
  );
  return {
    piloto: cuentaEnPiloto(id_configuracion),
    columna: COLUMNA,
    remarketing_columna_activo: Number(defecto?.n || 0) > 0,
    columnas,
    productos: productos.map((p) => {
      const c = porProducto.get(Number(p.id));
      const m = metricas.get(Number(p.id)) || null;
      return {
        id: p.id,
        nombre: p.nombre,
        precio: p.precio,
        imagen_url: p.imagen_url,
        anuncios: Number(p.anuncios || 0),
        wizard_activo: Number(p.wizard_activo || 0) === 1,
        wizard_flujo: Number(p.wizard_flujo || 0) === 1,
        estado: !c ? 'sin_configurar' : Number(c.activo) === 1 ? 'activo' : 'pausado',
        pasos: c ? leerJson(c.pasos, []).length : 0,
        // Los del recordatorio 1 (cada paso tiene los suyos).
        botones: c
          ? botonesDe({ botones: leerJson(c.botones, []) }, leerJson(c.pasos, [])[0]).map((b) => b.titulo)
          : [],
        actualizado: c?.updated_at || null,
        metricas: m,
      };
    }),
  };
}

/**
 * Lo que el cliente recibe ANTES del primer recordatorio: la respuesta al
 * «Hola, quiero info». La vista previa del editor la pinta para que la
 * conversación tenga sentido (el recordatorio sale porque el cliente dejó
 * de responder, no porque nadie le contestó).
 *  - origen 'wizard': el producto tiene sus ajustes avanzados (/productos)
 *    completos y activos → paquete de media + mensaje fijo, tal cual lo
 *    manda enviarPaqueteInicial (con los precios al día).
 *  - origen 'bot': sin ajustes → una respuesta tipo de la IA de Contacto
 *    inicial, armada con el nombre, el precio y la descripción del
 *    producto. Es ilustrativa: el texto real lo redacta la IA en cada chat.
 */
async function respuestaInicialDe(producto) {
  const {
    wizardActivoDeProducto,
  } = require('./producto_wizard_runtime.service');
  const {
    paqueteMedia,
    componerMensajeInicial,
    refrescarPreciosMensaje,
    fmtPrecio,
  } = require('../utils/wizardProducto/componerMensajeInicial');

  let wizard = null;
  try {
    wizard = await wizardActivoDeProducto(producto.id);
  } catch {
    wizard = null;
  }

  if (wizard) {
    const guardado = String(wizard.mensaje_inicial || '').trim();
    const texto =
      (guardado
        ? refrescarPreciosMensaje(guardado, producto, wizard.tipo_venta)
        : componerMensajeInicial({ producto, wizard })) || '';
    const { todas } = paqueteMedia({ producto, wizard });
    return {
      origen: 'wizard',
      texto: texto.trim(),
      media: todas.map((m) => ({ tipo: m.tipo, url: m.url, etiqueta: m.etiqueta || null })),
    };
  }

  const precio = fmtPrecio(producto.precio);
  const descripcion = String(producto.descripcion || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Primera oración de la descripción, corta, para que la respuesta tipo
  // hable del producto y no sea un relleno genérico.
  const resumen = descripcion
    ? descripcion.split(/(?<=[.!?])\s+/)[0].slice(0, 160).trim()
    : '';
  const partes = [`¡Hola! 😊 Con gusto te cuento sobre *${producto.nombre}*.`];
  if (resumen) partes.push(resumen);
  if (precio) partes.push(`💵 Precio: ${precio}\n🚚 Envío gratis y pagas al recibir`);
  partes.push('¿Para qué ciudad sería el envío?');
  return {
    origen: 'bot',
    texto: partes.join('\n\n'),
    media: producto.imagen_url ? [{ tipo: 'image', url: producto.imagen_url, etiqueta: 'Foto del producto' }] : [],
  };
}

async function obtener(id_configuracion, id_producto) {
  const producto = await productoDe(id_configuracion, id_producto);
  if (!producto) throw error('Producto no encontrado', 404);
  const config = await configDeProducto(id_configuracion, id_producto);
  const metricas = await metricasPorProducto(id_configuracion, 30);
  const columnas = await columnasDe(id_configuracion);
  const respuesta_inicial = await respuestaInicialDe(producto);
  return {
    producto,
    config: config || configPorDefecto(producto, columnas),
    existe: !!config,
    metricas: metricas.get(Number(id_producto)) || null,
    columnas,
    respuesta_inicial,
    // Botones que saldrían hoy en un recordatorio en modo «ofertas».
    ofertas: ofertasDe(producto),
    descuento: {
      defecto: DESCUENTO_PCT_DEFECTO,
      maximo: DESCUENTO_PCT_MAX,
      vigencia_horas: DESCUENTO_VIGENCIA_H,
    },
    variables: ['{{nombre}}', '{{producto}}', '{{precio}}'],
    limites: { pasos: MAX_PASOS, botones: MAX_BOTONES, titulo: MAX_TITULO, cuerpo: MAX_CUERPO, items: MAX_ITEMS_BLOQUE },
  };
}

async function guardar(id_configuracion, id_producto, body, { creado_por = null } = {}) {
  const producto = await productoDe(id_configuracion, id_producto);
  if (!producto) throw error('Producto no encontrado', 404);
  const cfg = normalizarConfig(body);
  await validarPlantillasDePasos(id_configuracion, cfg.pasos);
  await db.query(
    `INSERT INTO remarketing_producto
       (id_configuracion, id_producto, activo, pasos, imagen_url, botones, bloques, estado_destino, creado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE activo = VALUES(activo), pasos = VALUES(pasos),
       imagen_url = VALUES(imagen_url), botones = VALUES(botones), bloques = VALUES(bloques),
       estado_destino = VALUES(estado_destino), updated_at = NOW()`,
    {
      replacements: [
        id_configuracion,
        id_producto,
        cfg.activo,
        JSON.stringify(cfg.pasos),
        cfg.imagen_url,
        JSON.stringify(cfg.botones),
        JSON.stringify(cfg.bloques),
        cfg.estado_destino,
        creado_por,
      ],
      type: T.INSERT,
    },
  );
  return configDeProducto(id_configuracion, id_producto);
}

async function activar(id_configuracion, id_producto, activo) {
  // type UPDATE → [res, affectedRows]
  const [, afectadas] = await db.query(
    `UPDATE remarketing_producto SET activo = ?, updated_at = NOW()
      WHERE id_configuracion = ? AND id_producto = ?`,
    { replacements: [activo ? 1 : 0, id_configuracion, id_producto], type: T.UPDATE },
  );
  if (!activo) {
    // Lo que ya estaba en cola para este producto no debe salir.
    await db.query(
      `UPDATE remarketing_pendientes SET cancelado = 1, error_message = 'Remarketing del producto pausado'
        WHERE id_configuracion = ? AND id_producto = ? AND enviado = 0 AND cancelado = 0`,
      { replacements: [id_configuracion, id_producto], type: T.UPDATE },
    );
  }
  return Number(afectadas || 0) > 0;
}

async function eliminar(id_configuracion, id_producto) {
  await activar(id_configuracion, id_producto, false);
  await db.query(
    `DELETE FROM remarketing_producto WHERE id_configuracion = ? AND id_producto = ?`,
    { replacements: [id_configuracion, id_producto], type: T.DELETE },
  );
}

function errorSubida(mensaje, statusCode) {
  const e = new Error(mensaje);
  e.statusCode = statusCode;
  e.codigo = 'SUBIDA_FALLIDA';
  return e;
}

/** Media de los bloques (capturas de opiniones, fotos, video, PDF). */
async function subirMedia({
  id_configuracion,
  buffer,
  originalname,
  mimetype,
  jwtToken = null,
}) {
  /* El uploader S3 responde 500 a cualquier video (ver subirMedia del wizard
     de productos): los videos van a la Video API, la misma de las plantillas
     y del wizard, que necesita el JWT del usuario. Sin esto, subir un video
     en /remarketing fallaba siempre con «Uploader HTTP 500». */
  if (/^video\//.test(mimetype || '')) {
    if (!jwtToken) {
      throw errorSubida(
        'No se pudo subir el video: la sesión no trae token. Vuelve a iniciar sesión e inténtalo de nuevo.',
        401,
      );
    }
    let r;
    try {
      r = await uploadVideoToVideoAPI({
        buffer,
        originalname: originalname || 'video.mp4',
        mimetype,
        jwtToken,
      });
    } catch (e) {
      console.warn(
        `[RMK_PRODUCTO_UPLOAD] Video API falló (cfg ${id_configuracion}): ${e.message}`,
      );
      throw errorSubida(
        'No se pudo subir el video en este momento. Inténtalo de nuevo en unos minutos.',
        502,
      );
    }
    if (!r?.fileUrl) {
      throw errorSubida('El servidor de videos no devolvió la URL.', 502);
    }
    return { url: r.fileUrl, tipo: 'video', reutilizado: !!r.reutilizado };
  }

  const r = await uploadToUploader({
    buffer,
    originalname,
    mimetype,
    folder: `remarketing-producto/${id_configuracion}`,
  });
  const tipo = /^image\//.test(mimetype)
    ? 'image'
    : /^video\//.test(mimetype)
      ? 'video'
      : 'document';
  return { url: r.fileUrl, tipo, reutilizado: !!r.data?.reutilizado };
}

/* ── Eventos ──────────────────────────────────────────────────────────── */

async function registrarEvento({
  id_configuracion,
  id_producto,
  id_remarketing_producto,
  id_cliente_chat_center,
  id_pendiente = null,
  paso = null,
  evento,
  detalle = null,
}) {
  try {
    await db.query(
      `INSERT INTO remarketing_producto_eventos
         (id_configuracion, id_producto, id_remarketing_producto, id_cliente_chat_center, id_pendiente, paso, evento, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          id_producto,
          id_remarketing_producto,
          id_cliente_chat_center,
          id_pendiente,
          paso,
          evento,
          detalle ? String(detalle).slice(0, 255) : null,
        ],
        type: T.INSERT,
      },
    );
  } catch (e) {
    console.warn('[remarketing_producto] evento:', e.message);
  }
}

/* ── Resolución del producto en juego y programación ──────────────────── */

/**
 * ¿El cliente está hablando de un producto con remarketing propio activo?
 * El producto en juego es el del último anuncio (o elección del colchón)
 * mientras su ancla siga vigente, igual que para el wizard.
 * @returns {Promise<{config, producto}|null>}
 */
async function remarketingDelProductoEnJuego(id_configuracion, id_cliente) {
  if (!cuentaEnPiloto(id_configuracion)) return null;
  const [ad] = await db.query(
    `SELECT headline, source_id, created_at FROM cliente_productos_ad
      WHERE id_cliente = ? AND id_configuracion = ?
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_cliente, id_configuracion], type: T.SELECT },
  );
  const {
    anclaProductoVigente,
  } = require('../utils/webhook_whatsapp/colchonMensajeIlegible');
  const anclaVigente =
    !!ad &&
    (await anclaProductoVigente({
      id_configuracion,
      id_cliente,
      fecha_ancla: ad.created_at,
    }));
  let producto = null;
  if (anclaVigente) {
    const r = await resolverProductoAnuncio(id_configuracion, ad.headline, ad.source_id);
    producto = r?.producto?.id ? r.producto : null;
  } else {
    producto = await productoNombradoPorElCliente(id_configuracion, id_cliente);
  }
  if (!producto) return null;
  const config = await configDeProducto(id_configuracion, producto.id);
  if (!config || !config.activo || !config.pasos.length) return null;
  return { config, producto };
}

/**
 * Respaldo cuando no hay ancla de anuncio vigente: el cliente escribió sin
 * anuncio (o reinició la conversación) y NOMBRÓ el producto en sus últimos
 * mensajes. Solo se consideran los productos de la cuenta con remarketing
 * activo (son pocos) y se usa el mismo matcher conservador del wizard
 * (elegirProductoPorTexto: cobertura ≥ 60 % o el arranque del nombre; en
 * empate no se adivina). Si calza, se siembra el ancla para que los turnos
 * siguientes (botones, ficha) encuentren el producto por la vía normal.
 * Caso real 30-10-2026: Daniel reinició su chat de la 10 y escribió "quiero
 * los audífonos bluetooth" sin pasar por el anuncio: el ancla del 16-09 ya no
 * valía y el remarketing del producto no se agendaba.
 */
async function productoNombradoPorElCliente(id_configuracion, id_cliente) {
  const lista = await db.query(
    `SELECT p.id, p.nombre
       FROM remarketing_producto r
       JOIN productos_chat_center p ON p.id = r.id_producto
      WHERE r.id_configuracion = ? AND r.activo = 1 AND p.eliminado = 0`,
    { replacements: [id_configuracion], type: T.SELECT },
  );
  if (!lista.length) return null;
  const mensajes = await db.query(
    `SELECT m.texto_mensaje
       FROM mensajes_clientes m
      WHERE m.id_configuracion = ? AND m.celular_recibe = ? AND m.rol_mensaje = 0
        AND m.tipo_mensaje = 'text' AND m.texto_mensaje IS NOT NULL
        AND m.created_at > COALESCE(
              (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
              '1970-01-01')
      ORDER BY m.id DESC LIMIT 5`,
    { replacements: [id_configuracion, String(id_cliente), id_cliente], type: T.SELECT },
  );
  if (!mensajes.length) return null;
  const {
    elegirProductoPorTexto,
    sembrarProductoEnJuego,
  } = require('./producto_wizard_runtime.service');
  for (const m of mensajes) {
    const elegido = elegirProductoPorTexto(m.texto_mensaje, lista);
    if (!elegido) continue;
    const producto = await productoDe(id_configuracion, elegido.id);
    if (!producto) return null;
    await sembrarProductoEnJuego({
      id_cliente,
      id_configuracion,
      producto,
      texto_mensaje: m.texto_mensaje,
    });
    return producto;
  }
  return null;
}

/**
 * Qué paso toca agendar para este cliente. Si en las últimas 48 h ya se le
 * mandó el paso N de este producto, sigue el N+1; agotada la secuencia no se
 * agenda nada por producto (quien llama cae a la columna).
 * @returns {number|null} número de paso (1..n) o null si está agotada
 */
async function pasoQueToca(config, id_cliente) {
  const [ultimo] = await db.query(
    `SELECT paso_producto FROM remarketing_pendientes
      WHERE id_cliente_chat_center = ? AND id_remarketing_producto = ?
        AND enviado = 1 AND creado_en > NOW() - INTERVAL 48 HOUR
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_cliente, config.id], type: T.SELECT },
  );
  const siguiente = ultimo ? Number(ultimo.paso_producto || 0) + 1 : 1;
  return siguiente <= config.pasos.length ? siguiente : null;
}

/**
 * Inserta en remarketing_pendientes el paso `paso` del producto. La fila
 * lleva la plantilla de la columna como respaldo: si al disparar la ventana
 * de 24 h ya se cerró, el cron manda esa plantilla como hasta ahora.
 */
async function programarPasoProducto({
  id_configuracion,
  id_cliente,
  telefono,
  estado_contacto,
  config,
  producto,
  paso,
  respaldo = null, // fila de configuracion_remarketing (secuencia 1) o null
  template_parameters = null,
}) {
  const p = config.pasos[paso - 1];
  if (!p) return null;
  // La plantilla elegida para el paso manda; si no hay, la de la columna.
  if (p.plantilla?.nombre_template) {
    respaldo = {
      nombre_template: p.plantilla.nombre_template,
      language_code: p.plantilla.language_code || 'es',
      header_format: p.plantilla.header_format || null,
      header_media_url: p.plantilla.header_media_url || null,
      header_media_name: null,
      header_parameters: null,
    };
    // Plantilla propia sin variables: no se heredan parámetros de la columna.
    template_parameters = null;
  }
  const [cfg] = await db.query(
    `SELECT telefono FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: T.SELECT },
  );
  const telefono_configuracion = cfg?.telefono ? String(cfg.telefono) : null;
  if (!telefono_configuracion) return null;

  const tiempoDisparo = new Date(Date.now() + p.minutos * 60 * 1000);
  // Con type INSERT, Sequelize devuelve [insertId, affectedRows].
  const [insertId] = await db.query(
    `INSERT INTO remarketing_pendientes
       (telefono, telefono_configuracion, id_cliente_chat_center, id_configuracion,
        estado_contacto_origen, nombre_template, language_code, tiempo_disparo, estado_destino,
        header_format, header_media_url, header_media_name, header_parameters,
        id_template_rapido, usar_respuesta_rapida, metodo_dentro_24h, prompt_ia, template_parameters,
        enviado, cancelado, secuencia, id_remarketing_producto, id_producto, paso_producto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    {
      replacements: [
        telefono,
        telefono_configuracion,
        id_cliente,
        id_configuracion,
        estado_contacto || COLUMNA,
        respaldo?.nombre_template || null,
        respaldo?.language_code || 'es',
        tiempoDisparo,
        // Solo el ÚLTIMO recordatorio mueve de columna: los intermedios dejan
        // al cliente en Contacto inicial para que, si responde, el bot siga
        // ahí y el siguiente paso se reprograme (programarRemarketingKanban
        // solo actúa en esa columna). Mismo criterio que la secuencia de
        // columna en configurar_remarketing.
        paso >= config.pasos.length ? config.estado_destino || null : null,
        respaldo?.header_format || null,
        respaldo?.header_media_url ? String(respaldo.header_media_url).replace(/&amp;/g, '&') : null,
        respaldo?.header_media_name || null,
        respaldo?.header_parameters || null,
        null,
        0,
        // ENUM('ninguno','respuesta_rapida','ia'): la marca del producto es
        // id_remarketing_producto; con 'ninguno' el cron, si la ventana está
        // cerrada, cae directo a la plantilla de respaldo.
        'ninguno',
        null,
        Array.isArray(template_parameters) && template_parameters.length
          ? JSON.stringify(template_parameters.map((v) => String(v ?? '')))
          : null,
        paso,
        config.id,
        producto.id,
        paso,
      ],
      type: T.INSERT,
    },
  );
  return { id: insertId || null, minutos: p.minutos, paso };
}

/** Encadenado desde el cron: tras enviar el paso N, agenda el N+1 si existe. */
async function programarSiguientePasoProducto(record) {
  const config = await cargarConfig(record.id_remarketing_producto);
  if (!config || !config.activo) return false;
  const paso = Number(record.paso_producto || 1) + 1;
  if (!config.pasos[paso - 1]) return false;
  await db.query(
    `UPDATE remarketing_pendientes SET cancelado = 1
      WHERE id_cliente_chat_center = ? AND id_configuracion = ? AND enviado = 0 AND cancelado = 0 AND id != ?`,
    { replacements: [record.id_cliente_chat_center, record.id_configuracion, record.id], type: T.UPDATE },
  );
  const r = await programarPasoProducto({
    id_configuracion: record.id_configuracion,
    id_cliente: record.id_cliente_chat_center,
    telefono: record.telefono,
    estado_contacto: record.estado_destino || record.estado_contacto_origen,
    config,
    producto: { id: record.id_producto },
    paso,
    respaldo: record.nombre_template
      ? {
          nombre_template: record.nombre_template,
          language_code: record.language_code,
          header_format: record.header_format,
          header_media_url: record.header_media_url,
          header_media_name: record.header_media_name,
          header_parameters: record.header_parameters,
        }
      : null,
    template_parameters: leerJson(record.template_parameters, null),
  });
  return !!r;
}

/* ── Envío (cron) ─────────────────────────────────────────────────────── */

async function contactoPropietario(id_configuracion, telefono_configuracion) {
  const tel = String(telefono_configuracion || '').replace(/\D/g, '');
  if (!tel) return null;
  const [c] = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE REPLACE(celular_cliente, ' ', '') = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [tel, id_configuracion], type: T.SELECT },
  );
  return c?.id || null;
}

async function registrarMensajeSaliente({
  record,
  cfg,
  telefonoLimpio,
  tipo_mensaje,
  texto_mensaje,
  ruta_archivo = null,
  wamid,
  responsable = RESPONSABLE,
}) {
  const propietario = await contactoPropietario(
    record.id_configuracion,
    record.telefono_configuracion || cfg?.telefono_configuracion,
  );
  await MensajesClientes.create({
    id_configuracion: record.id_configuracion,
    id_cliente: propietario || record.id_cliente_chat_center,
    mid_mensaje: cfg.PHONE_NUMBER_ID,
    tipo_mensaje,
    rol_mensaje: 1,
    celular_recibe: record.id_cliente_chat_center,
    responsable,
    texto_mensaje,
    ruta_archivo,
    visto: 1,
    uid_whatsapp: telefonoLimpio,
    id_wamid_mensaje: wamid || null,
  });
}

/**
 * Manda el paso del producto: texto + (foto de cabecera) + botones reply.
 * Solo se llama con la ventana de 24 h abierta. Lanza si Meta responde con
 * error (el cron decide si es rate limit o reintento).
 */
async function enviarPasoProducto({ record, cfg, telefonoLimpio }) {
  const config = await cargarConfig(record.id_remarketing_producto);
  if (!config || !config.activo) return { ok: false, motivo: 'configuracion_inactiva' };
  const paso = config.pasos[Number(record.paso_producto || 1) - 1];
  if (!paso) return { ok: false, motivo: 'paso_inexistente' };
  // Paso que cae fuera de las 24 h: sale SOLO como su plantilla de Meta,
  // aunque la ventana esté abierta en ese momento (Daniel: sin envoltorios).
  const idxPaso = Number(record.paso_producto || 1) - 1;
  if (paso.plantilla?.nombre_template && acumuladoHasta(config.pasos, idxPaso) > LIMITE_VENTANA_MIN) {
    return { ok: false, motivo: 'paso_de_plantilla' };
  }
  if (!String(paso.mensaje || '').trim()) return { ok: false, motivo: 'sin_mensaje_solo_plantilla' };
  const producto = await productoDe(record.id_configuracion, record.id_producto);
  if (!producto) return { ok: false, motivo: 'producto_inexistente' };

  const [cliente] = await db.query(
    `SELECT nombre_cliente FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [record.id_cliente_chat_center], type: T.SELECT },
  );
  const texto = rellenar(paso.mensaje, {
    nombre: primerNombre(cliente?.nombre_cliente),
    producto: producto.nombre,
    precio: fmtPrecio(producto.precio),
  }).slice(0, MAX_CUERPO);

  const imagen = paso.con_imagen ? imagenDe(config, paso) || producto.imagen_url || null : null;
  const botones = botonesDelEnvio(config, paso, producto);

  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${cfg.ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  let wamid = null;
  let registroTexto = texto;
  if (botones.length) {
    const interactive = {
      type: 'button',
      body: { text: texto },
      action: {
        buttons: botones.map((b) => ({
          type: 'reply',
          reply: { id: `${PREFIJO_BOTON}${record.id}_${b.clave}`, title: b.titulo },
        })),
      },
    };
    if (imagen) interactive.header = { type: 'image', image: { link: imagen } };
    const resp = await axios.post(
      url,
      { messaging_product: 'whatsapp', to: telefonoLimpio, type: 'interactive', interactive },
      { headers, timeout: 30000 },
    );
    wamid = resp.data?.messages?.[0]?.id || null;
    registroTexto = `${texto}\n\n${botones.map((b) => `[ ${b.titulo} ]`).join('  ')}`;
  } else {
    if (imagen) {
      const resp = await axios.post(
        url,
        { messaging_product: 'whatsapp', to: telefonoLimpio, type: 'image', image: { link: imagen, caption: texto } },
        { headers, timeout: 30000 },
      );
      wamid = resp.data?.messages?.[0]?.id || null;
    } else {
      const resp = await axios.post(
        url,
        { messaging_product: 'whatsapp', to: telefonoLimpio, type: 'text', text: { body: texto, preview_url: false } },
        { headers, timeout: 30000 },
      );
      wamid = resp.data?.messages?.[0]?.id || null;
    }
  }
  if (!wamid) return { ok: false, motivo: 'meta_sin_wamid' };

  await registrarMensajeSaliente({
    record,
    cfg,
    telefonoLimpio,
    tipo_mensaje: imagen ? 'image' : 'text',
    texto_mensaje: registroTexto,
    ruta_archivo: imagen || null,
    wamid,
  });
  await registrarEvento({
    id_configuracion: record.id_configuracion,
    id_producto: record.id_producto,
    id_remarketing_producto: config.id,
    id_cliente_chat_center: record.id_cliente_chat_center,
    id_pendiente: record.id,
    paso: Number(record.paso_producto || 1),
    evento: 'enviado',
    detalle: botones.length ? botones.map((b) => b.clave).join(',') : 'sin_botones',
  });
  return { ok: true, wamid, texto };
}

/* ── Respuesta del cliente (webhook) ──────────────────────────────────── */

/** `rmkp_<id_pendiente>_<clave>` → { id_pendiente, clave, titulo } o null. */
/** `rmkp_<id_pendiente>_<clave>` → { id_pendiente, clave, titulo } o null.
 *  Botón de un envío de PRUEBA («Mándamelo a mi WhatsApp»):
 *  `rmkp_t<id_producto>_<paso>_<clave>` → { prueba:true, id_producto, paso, clave }.
 *  Antes la prueba mandaba `rmkp_0_<clave>`, que no apuntaba a ninguna fila
 *  de la cola y el toque lo contestaba la IA como un mensaje cualquiera
 *  (Daniel, cfg 610, 06-11-2026). */
function interpretarBotonProducto(interactive) {
  const rep = interactive?.button_reply || interactive?.list_reply;
  const id = String(rep?.id || '');
  if (!id.startsWith(PREFIJO_BOTON)) return null;
  const resto = id.slice(PREFIJO_BOTON.length);
  const titulo = String(rep?.title || '').trim();
  const prueba = resto.match(/^t(\d+)_(\d+)_([a-z0-9_]+)$/);
  if (prueba) {
    return { prueba: true, id_producto: Number(prueba[1]), paso: Number(prueba[2]), clave: prueba[3], titulo };
  }
  const m = resto.match(/^(\d+)_([a-z0-9_]+)$/);
  if (!m) return null;
  return { id_pendiente: Number(m[1]), clave: m[2], titulo };
}

const esperar = (seg) => new Promise((r) => setTimeout(r, Math.max(0, seg) * 1000));

async function enviarBloque({ bloque, id_configuracion, telefono, business_phone_id, accessToken, log }) {
  let enviados = 0;
  for (const it of bloque.items || []) {
    if (enviados > 0) await esperar(it.retraso_seg ?? 2);
    if (it.tipo === 'text') {
      await enviarMensajeWhatsapp({
        phone_whatsapp_to: telefono,
        texto_mensaje: it.texto,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable: RESPONSABLE_BLOQUE,
      });
      enviados += 1;
      continue;
    }
    const r = await enviarMedioWhatsapp({
      tipo: it.tipo,
      url_archivo: it.url,
      phone_whatsapp_to: telefono,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: RESPONSABLE_BLOQUE,
      filename: it.tipo === 'document' ? it.texto || 'archivo.pdf' : null,
    });
    if (r?.ok === false) {
      await log(`⚠️ remarketing producto: no salió ${it.tipo} ${it.url}: ${JSON.stringify(r.error)}`);
      continue;
    }
    enviados += 1;
    if (it.texto && it.tipo !== 'document') {
      await esperar(1);
      await enviarMensajeWhatsapp({
        phone_whatsapp_to: telefono,
        texto_mensaje: it.texto,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable: RESPONSABLE_BLOQUE,
      });
    }
  }
  if (bloque.remate) {
    if (enviados > 0) await esperar(2);
    await enviarMensajeWhatsapp({
      phone_whatsapp_to: telefono,
      texto_mensaje: bloque.remate,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: RESPONSABLE_BLOQUE,
    });
  }
  return enviados;
}

/**
 * El cliente tocó un botón del recordatorio. Devuelve qué hacer con el turno:
 *  - { manejado:true, saltarIA:true }                → ya se contestó (bloque).
 *  - { manejado:true, saltarIA:false, mensaje_para_ia } → que la IA cierre
 *    con ese contexto.
 *  - { manejado:false }                               → no era nuestro.
 */
async function atenderBotonProducto({
  id_pendiente = null,
  prueba = false,
  id_producto = null,
  paso: pasoPrueba = null,
  clave,
  titulo,
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  log = async () => {},
}) {
  const nada = { manejado: false };
  let config = null;
  let producto = null;
  let pend = null;
  let numPaso = 1;
  if (prueba) {
    // Botón de un envío de prueba: no hay fila en la cola; se atiende con la
    // configuración GUARDADA del producto (si el dueño probó sin guardar y
    // no hay nada guardado, sigue la IA) y sin anotar eventos, para no
    // ensuciar las métricas con las pruebas del dueño.
    config = await configDeProducto(id_configuracion, id_producto);
    producto = await productoDe(id_configuracion, id_producto);
    if (!config || !producto) {
      await log(`🛍️ remarketing producto: botón de prueba «${titulo}» sin configuración guardada del producto ${id_producto}; sigue la IA`);
      return nada;
    }
    numPaso = Number(pasoPrueba || 1);
  } else {
    [pend] = await db.query(
      `SELECT id, id_cliente_chat_center, id_remarketing_producto, id_producto, paso_producto
         FROM remarketing_pendientes WHERE id = ? AND id_configuracion = ? LIMIT 1`,
      { replacements: [id_pendiente, id_configuracion], type: T.SELECT },
    );
    if (!pend || Number(pend.id_cliente_chat_center) !== Number(id_cliente) || !pend.id_remarketing_producto) {
      return nada;
    }
    config = await cargarConfig(pend.id_remarketing_producto);
    producto = await productoDe(id_configuracion, pend.id_producto);
    if (!config || !producto) return nada;
    numPaso = Number(pend.paso_producto || 1);
  }
  // El botón pertenece al recordatorio que se le mandó (paso_producto de la
  // fila): cada paso tiene sus botones. Si el dueño quitó ese paso después
  // del envío, se busca la clave en cualquier paso. El contenido (bloques)
  // es el mismo del producto para todos.
  const paso = config.pasos[numPaso - 1] || null;
  // Botón de oferta («2 por $34,99»): la cantidad va en la clave y el precio
  // se lee del producto AHORA (si el dueño cambió el combo entre el envío y
  // el toque, manda el vigente; si lo quitó, queda solo la cantidad).
  const esOferta = String(clave).match(/^oferta_([0-9]+)$/);
  const oferta = esOferta
    ? ofertasDe(producto).find((o) => o.cantidad === Number(esOferta[1])) || {
        clave,
        titulo,
        accion: 'oferta',
        cantidad: Number(esOferta[1]),
        precio: null,
      }
    : null;
  const todosLosBotones = config.pasos.flatMap((p) => botonesDe(config, p));
  const boton =
    oferta ||
    botonesDe(config, paso).find((b) => b.clave === clave) ||
    todosLosBotones.find((b) => b.clave === clave) ||
    { clave, titulo, accion: 'cerrar' };
  const bloques = config.bloques || {};
  const base = {
    id_configuracion,
    id_producto: producto.id,
    id_remarketing_producto: config.id,
    id_cliente_chat_center: id_cliente,
    id_pendiente: pend?.id || null,
    paso: numPaso,
  };
  const registrarEventoReal = prueba ? async () => {} : registrarEvento;
  await registrarEventoReal({ ...base, evento: 'boton', detalle: boton.clave });
  if (prueba) await log(`🛍️ remarketing producto: botón de PRUEBA «${boton.titulo}» (recordatorio ${numPaso}, producto ${producto.id})`);

  // El producto queda «en juego» como si hubiera entrado por el anuncio.
  const {
    sembrarProductoEnJuego,
  } = require('./producto_wizard_runtime.service');
  await sembrarProductoEnJuego({
    id_cliente,
    id_configuracion,
    producto: { nombre: producto.nombre },
    texto_mensaje: boton.titulo,
  });

  const precio = fmtPrecio(producto.precio);
  const refProducto = `"${producto.nombre}"${precio ? ` (${precio})` : ''}`;

  if (boton.accion === 'bloque') {
    const bloque = bloques?.[boton.clave];
    if (bloque && ((bloque.items || []).length || bloque.remate)) {
      if (!(bloque.items || []).length) {
        // El dueño todavía no cargó contenido real. No se inventa nada: se
        // dice la verdad y se sigue con la pregunta de cierre del remate.
        await enviarMensajeWhatsapp({
          phone_whatsapp_to: telefono,
          texto_mensaje: `Todavía no tenemos opiniones publicadas de ${producto.nombre}, pero cualquier duda te la resuelvo ahora mismo 🙂`,
          business_phone_id,
          accessToken,
          id_configuracion,
          responsable: RESPONSABLE_BLOQUE,
        });
        await registrarEventoReal({ ...base, evento: 'bloque_vacio', detalle: boton.clave });
        await esperar(1);
      }
      const n = await enviarBloque({
        bloque,
        id_configuracion,
        telefono,
        business_phone_id,
        accessToken,
        log,
      });
      await registrarEventoReal({ ...base, evento: 'bloque', detalle: `${boton.clave}:${n}` });
      await log(`🛍️ remarketing producto: «${boton.titulo}» → bloque ${boton.clave} (${n} elementos) producto ${producto.id}`);
      return { manejado: true, saltarIA: true };
    }
    await log(`🛍️ remarketing producto: «${boton.titulo}» sin bloque configurado; sigue la IA`);
    return {
      manejado: true,
      saltarIA: false,
      mensaje_para_ia: `[El cliente tocó el botón «${boton.titulo}» del recordatorio del producto ${refProducto}. Responde a eso con lo que sabes del producto y lleva la conversación al cierre.]\nMensaje del cliente: ${boton.titulo}`,
    };
  }

  // Oferta elegida («2 por $34,99»): el cliente ya dijo cuántas quiere y a
  // qué precio. El bot no vuelve a preguntar cantidad ni a presentar.
  if (boton.accion === 'oferta') {
    await registrarEventoReal({ ...base, evento: 'cierre_ia', detalle: boton.clave });
    await log(`🛍️ remarketing producto: oferta «${boton.titulo}» (${boton.cantidad} u.) producto ${producto.id}`);
    const unidades = `${boton.cantidad} unidad${boton.cantidad === 1 ? '' : 'es'}`;
    const total = boton.precio ? ` por ${fmtPrecioCatalogo(boton.precio)} en total` : '';
    return {
      manejado: true,
      saltarIA: false,
      mensaje_para_ia:
        `[El cliente tocó la oferta «${boton.titulo}» en el recordatorio del producto "${producto.nombre}": ` +
        `quiere ${unidades}${total} (es la oferta vigente del producto). La cantidad ya está decidida: ` +
        'no la vuelvas a preguntar ni vuelvas a presentar el producto; confirma en una línea su elección ' +
        'y pasa directo a tomar los datos del pedido.]\n' +
        `Mensaje del cliente: Quiero ${unidades} de ${producto.nombre}`,
    };
  }

  // «Quiero mi 10% OFF»: el descuento queda anotado para este cliente (vale
  // DESCUENTO_VIGENCIA_H horas o hasta crear el pedido). De ahí en adelante
  // cada turno de la IA lleva el bloque de descuento (bloqueDescuentoParaIA)
  // y el total del pedido se cuadra en código (aplicarDescuentoAlTotal).
  // Se anota también en las pruebas del dueño: sin eso no podría probar que
  // el bot lo aplica (no entra en las métricas de botones).
  if (boton.accion === 'descuento') {
    const pct = pctValido(boton.descuento_pct);
    await registrarEvento({ ...base, evento: 'descuento', detalle: String(pct) });
    await registrarEventoReal({ ...base, evento: 'cierre_ia', detalle: boton.clave });
    await log(`🛍️ remarketing producto: «${boton.titulo}» → ${pct}% de descuento para el cliente ${id_cliente}, producto ${producto.id}`);
    return {
      manejado: true,
      saltarIA: false,
      mensaje_para_ia:
        `[El cliente tocó «${boton.titulo}» en el recordatorio del producto ${refProducto}: quiere comprarlo ` +
        `con el ${pct}% de descuento que le ofrecimos. Confírmale con entusiasmo que su ${pct}% de descuento ` +
        'ya quedó aplicado a su pedido, no vuelvas a presentar el producto; confirma la cantidad si hace falta ' +
        'y pasa directo a tomar los datos del pedido.]\n' +
        `Mensaje del cliente: ${boton.titulo}`,
    };
  }

  // «Sí, lo quiero» (o cualquier botón sin bloque): el bot sigue cerrando
  // la venta por el camino de siempre (respuestas rápidas del wizard → IA),
  // con el producto ya sembrado y la pista de que el cliente ya decidió.
  // Si el producto tiene un embudo por pasos activo, intentarPasoFlujo lo
  // retoma solo en el webhook; aquí no se arranca nada.
  await registrarEventoReal({ ...base, evento: 'cierre_ia', detalle: boton.clave });
  await log(`🛍️ remarketing producto: «${boton.titulo}» → el bot sigue cerrando, producto ${producto.id}`);
  return {
    manejado: true,
    saltarIA: false,
    mensaje_para_ia: `[El cliente tocó «${boton.titulo}» en el recordatorio del producto ${refProducto}: quiere comprarlo. No vuelvas a presentar el producto ni sus beneficios; confirma cantidad si hace falta y pasa directo a tomar los datos del pedido.]\nMensaje del cliente: ${boton.titulo}`,
  };
}

/**
 * Respuesta libre (no botón) a un recordatorio por producto enviado en las
 * últimas 72 h: cuenta como «respondió» una vez por envío.
 */
async function registrarRespuestaProducto({ id_cliente, id_configuracion }) {
  // Se llama en cada mensaje entrante de las cuentas kanban: fuera del
  // piloto no se consulta nada.
  if (!cuentaEnPiloto(id_configuracion)) return false;
  try {
    // Solo el ÚLTIMO recordatorio enviado cuenta; si ya tiene respuesta
    // anotada no se vuelve atrás a marcar los anteriores.
    const [pend] = await db.query(
      `SELECT p.id, p.id_producto, p.id_remarketing_producto, p.paso_producto,
              EXISTS (SELECT 1 FROM remarketing_producto_eventos e
                       WHERE e.id_pendiente = p.id AND e.evento IN ('respondio','boton')) AS ya
         FROM remarketing_pendientes p
        WHERE p.id_cliente_chat_center = ? AND p.id_configuracion = ?
          AND p.id_remarketing_producto IS NOT NULL AND p.enviado = 1
          AND p.ultimo_intento_at > NOW() - INTERVAL ${VENTANA_RESPUESTA_H} HOUR
        ORDER BY p.id DESC LIMIT 1`,
      { replacements: [id_cliente, id_configuracion], type: T.SELECT },
    );
    if (!pend || Number(pend.ya)) return false;
    await registrarEvento({
      id_configuracion,
      id_producto: pend.id_producto,
      id_remarketing_producto: pend.id_remarketing_producto,
      id_cliente_chat_center: id_cliente,
      id_pendiente: pend.id,
      paso: pend.paso_producto,
      evento: 'respondio',
    });
    return true;
  } catch (e) {
    if (!/doesn't exist|Unknown column/i.test(e.message)) {
      console.warn('[remarketing_producto] respuesta:', e.message);
    }
    return false;
  }
}

/* ── Descuento del cliente (botón «Quiero mi 10% OFF») ────────────────── */

/**
 * ¿Este cliente tiene un descuento vigente por haber tocado el botón de
 * descuento de un recordatorio? Vale DESCUENTO_VIGENCIA_H horas, se corta si
 * la conversación se reinició y se apaga al crear el pedido
 * ('descuento_usado'). Se consulta en cada turno del bot (índice por cliente).
 * @returns {Promise<null|{pct:number, id_producto:number, producto:string, id_remarketing_producto:number}>}
 */
async function descuentoVigente({ id_configuracion, id_cliente }) {
  if (!id_cliente || !cuentaEnPiloto(id_configuracion)) return null;
  try {
    const [e] = await db.query(
      `SELECT e.evento, e.detalle, e.id_producto, e.id_remarketing_producto, p.nombre
         FROM remarketing_producto_eventos e
         LEFT JOIN productos_chat_center p ON p.id = e.id_producto
        WHERE e.id_cliente_chat_center = ? AND e.id_configuracion = ?
          AND e.evento IN ('descuento', 'descuento_usado')
          AND e.created_at > NOW() - INTERVAL ${DESCUENTO_VIGENCIA_H} HOUR
          AND e.created_at > COALESCE(
                (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c WHERE c.id = ?),
                '1970-01-01')
        ORDER BY e.id DESC LIMIT 1`,
      { replacements: [id_cliente, id_configuracion, id_cliente], type: T.SELECT },
    );
    if (!e || e.evento !== 'descuento') return null;
    const pct = Math.round(Number(e.detalle));
    if (!Number.isFinite(pct) || pct < 1 || pct > DESCUENTO_PCT_MAX) return null;
    return {
      pct,
      id_producto: Number(e.id_producto),
      producto: e.nombre || '',
      id_remarketing_producto: Number(e.id_remarketing_producto),
    };
  } catch (err) {
    if (!/doesn't exist|Unknown column/i.test(err.message)) {
      console.warn('[remarketing_producto] descuento:', err.message);
    }
    return null;
  }
}

/** Bloque que va en el contexto de CADA turno mientras el descuento valga. */
function bloqueDescuentoParaIA(desc) {
  if (!desc?.pct) return '';
  const p = desc.pct;
  const ejemplo = (40 * (100 - p)) / 100;
  return [
    '🎁 DESCUENTO ACTIVO DE ESTE CLIENTE (dato del sistema: es real y está autorizado por el negocio)',
    `El cliente tocó el botón de descuento del recordatorio${desc.producto ? ` de "${desc.producto}"` : ''}: tiene ${p}% de descuento en este pedido.`,
    `- Se aplica sobre el total de los productos del pedido: primero el precio normal que corresponde a la cantidad (el combo si lo hay) y a eso se le resta el ${p}%.`,
    `- Cuando des el precio o el resumen, muéstralo así: "Precio normal: $X", "Descuento ${p}%: -$Y" y "Precio total: $Z". La línea "Precio total:" lleva SOLO el total final ya con el descuento.`,
    `- Ejemplo: precio normal $40 → con ${p}% de descuento el total es $${ejemplo.toFixed(2)}.`,
    '- Ya está aprobado: no digas que lo vas a consultar ni se lo vuelvas a ofrecer como novedad. No lo acumules con otro descuento ni des un porcentaje mayor.',
  ].join('\n');
}

/** El pedido se cerró: el descuento ya se usó y no vale para otro pedido. */
async function marcarDescuentoUsado({ id_configuracion, id_cliente }) {
  const desc = await descuentoVigente({ id_configuracion, id_cliente });
  if (!desc) return false;
  await registrarEvento({
    id_configuracion,
    id_producto: desc.id_producto,
    id_remarketing_producto: desc.id_remarketing_producto,
    id_cliente_chat_center: id_cliente,
    evento: 'descuento_usado',
    detalle: String(desc.pct),
  });
  return true;
}

/* ── Prueba desde la pantalla ─────────────────────────────────────────── */

/**
 * Manda el paso 1 (o el indicado) al número que pide el dueño, con los datos
 * del producto, sin tocar la cola ni los eventos. Sirve para ver cómo llega.
 */
async function enviarPrueba({ id_configuracion, id_producto, telefono, paso = 1, config: configBody = null }) {
  const producto = await productoDe(id_configuracion, id_producto);
  if (!producto) throw error('Producto no encontrado', 404);
  const config = configBody ? { id: 0, ...normalizarConfig(configBody) } : await configDeProducto(id_configuracion, id_producto);
  if (!config) throw error('Guarda la configuración antes de probar');
  if (!config.pasos[paso - 1]) paso = 1;
  const p = config.pasos[paso - 1];
  const esPasoDePlantilla =
    p?.plantilla?.nombre_template && acumuladoHasta(config.pasos, paso - 1) > LIMITE_VENTANA_MIN;
  if (esPasoDePlantilla || !String(p?.mensaje || '').trim()) {
    throw error(
      `El recordatorio ${paso} sale como plantilla de Meta («${p?.plantilla?.nombre_template || 'sin elegir'}»), no como mensaje libre; la plantilla se prueba desde el chat con «Responder con plantilla».`,
      409,
      'SOLO_PLANTILLA',
    );
  }
  const cfg = await getConfigFromDB(id_configuracion);
  if (!cfg?.PHONE_NUMBER_ID || !cfg?.ACCESS_TOKEN) throw error('La conexión de WhatsApp no está configurada', 409);
  const to = String(telefono || '').replace(/\D/g, '');
  if (to.length < 8) throw error('Número de prueba inválido');

  // El número de prueba suele ser un contacto de la cuenta (el dueño le
  // escribió al negocio para abrir la ventana): se usa SU nombre, como en
  // un envío real, y «Daniela» solo si no existe. Y se registra el mensaje
  // en el chat, con su wamid, para que en /chat se vea el recordatorio y la
  // respuesta del botón lo cite en vez de «Mensaje original no disponible».
  const [contacto] = await db.query(
    `SELECT id, nombre_cliente FROM clientes_chat_center
      WHERE id_configuracion = ? AND REPLACE(celular_cliente, ' ', '') = ?
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_configuracion, to], type: T.SELECT },
  );
  const nombre = primerNombre(contacto?.nombre_cliente) || 'Daniela';
  const texto = rellenar(p.mensaje, { nombre, producto: producto.nombre, precio: fmtPrecio(producto.precio) }).slice(0, MAX_CUERPO);
  const imagen = p.con_imagen ? imagenDe(config, p) || producto.imagen_url || null : null;
  const botones = botonesDelEnvio(config, p, producto);
  const interactive = {
    type: 'button',
    body: { text: texto },
    action: {
      // Id de prueba con producto y recordatorio: el webhook lo atiende con
      // la configuración guardada (ver interpretarBotonProducto).
      buttons: botones.map((b) => ({
        type: 'reply',
        reply: { id: `${PREFIJO_BOTON}t${producto.id}_${paso}_${b.clave}`, title: b.titulo },
      })),
    },
  };
  if (imagen) interactive.header = { type: 'image', image: { link: imagen } };
  const body = botones.length
    ? { messaging_product: 'whatsapp', to, type: 'interactive', interactive }
    : imagen
      ? { messaging_product: 'whatsapp', to, type: 'image', image: { link: imagen, caption: texto } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } };
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.PHONE_NUMBER_ID}/messages`,
      body,
      { headers: { Authorization: `Bearer ${cfg.ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    const wamid = resp.data?.messages?.[0]?.id || null;
    if (contacto?.id && wamid) {
      await registrarMensajeSaliente({
        record: {
          id_configuracion,
          id_cliente_chat_center: contacto.id,
          telefono_configuracion: cfg.telefono_configuracion || null,
        },
        cfg,
        telefonoLimpio: to,
        tipo_mensaje: imagen ? 'image' : 'text',
        texto_mensaje: botones.length ? `${texto}\n\n${botones.map((b) => `[ ${b.titulo} ]`).join('  ')}` : texto,
        ruta_archivo: imagen || null,
        wamid,
        responsable: 'prueba_remarketing_producto',
      }).catch((e) => console.warn('[remarketing_producto] prueba sin registrar en el chat:', e.message));
    }
    return { ok: true, wamid, texto, nombre };
  } catch (e) {
    const err = e.response?.data?.error;
    const msg = err?.message || e.message;
    if (/131047|re-engagement|24/i.test(`${err?.code} ${msg}`)) {
      throw error('Ese número no te ha escrito en las últimas 24 h: WhatsApp no deja mandarle un mensaje libre. Escríbele primero desde ese celular y vuelve a probar.', 409, 'VENTANA_CERRADA');
    }
    throw error(`WhatsApp rechazó el envío: ${msg}`, 502);
  }
}

module.exports = {
  PILOTO,
  COLUMNA,
  RESPONSABLE,
  RESPONSABLE_BLOQUE,
  PREFIJO_BOTON,
  BOTONES_DEFECTO,
  BOTONES_DEFECTO_POR_PASO,
  PASOS_DEFECTO,
  LIMITE_VENTANA_MIN,
  normalizarConfig,
  validarPlantillasDePasos,
  acumuladoHasta,
  cuentaEnPiloto,
  rellenar,
  botonesDe,
  imagenDe,
  listar,
  obtener,
  guardar,
  activar,
  eliminar,
  subirMedia,
  remarketingDelProductoEnJuego,
  pasoQueToca,
  programarPasoProducto,
  programarSiguientePasoProducto,
  enviarPasoProducto,
  interpretarBotonProducto,
  atenderBotonProducto,
  registrarRespuestaProducto,
  registrarEvento,
  enviarPrueba,
  ofertasDe,
  botonesDelEnvio,
  descuentoVigente,
  bloqueDescuentoParaIA,
  marcarDescuentoUsado,
  DESCUENTO_PCT_DEFECTO,
  DESCUENTO_VIGENCIA_H,
};
