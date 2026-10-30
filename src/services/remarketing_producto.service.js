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
  getConfigFromDB,
} = require('../utils/whatsappTemplate.helpers');

const T = db.QueryTypes;

/* ── Piloto ─────────────────────────────────────────────────────────────
   Como Campañas: lista de cuentas; vacía = todas. Mientras es beta solo
   corre (y solo se ve en el menú) en estas cuentas. El front tiene la misma
   lista en pages/remarketingProducto. */
const PILOTO = String(process.env.REMARKETING_PRODUCTO_PILOTO ?? '10,610,822')
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

// 1 h → 5 h → 8 h: suman 14 h, todos dentro de la ventana sin plantilla.
const PASOS_DEFECTO = [
  {
    minutos: 60,
    mensaje:
      'Hola {{nombre}} 👋 Vi que te interesó *{{producto}}* y quedó pendiente. ¿Te ayudo a completar tu pedido? Para tu tranquilidad, aquí puedes ver más 👇',
    con_imagen: true,
    con_botones: true,
  },
  {
    minutos: 300,
    mensaje:
      '{{nombre}}, sigo por aquí 🙂 *{{producto}}* todavía está disponible. ¿Te quedó alguna duda? Te la resuelvo ahora mismo 👇',
    con_imagen: false,
    con_botones: true,
    // Mismos botones (misma acción), otro texto: que no se lea repetido.
    botones_titulos: { opiniones: '👀 Ver qué opinan', quiero: '🛒 Pedirlo ahora' },
  },
  {
    minutos: 480,
    mensaje:
      'Última llamada, {{nombre}} 🙌 Para que no te quedes sin *{{producto}}*, te lo dejo listo para pedir hoy. ¿Lo aseguramos? 👇',
    con_imagen: true,
    con_botones: true,
    botones_titulos: { opiniones: '⭐ Opiniones reales', quiero: '✅ Quiero el mío' },
  },
];

/* Botones de un paso: los de la configuración (clave + acción) con el texto
   propio del paso si lo definió. Así el 2.º y 3.º recordatorio no repiten
   «Ver opiniones / Sí, lo quiero» aunque hagan lo mismo. */
function botonesDelPaso(config, paso) {
  const titulos = paso?.botones_titulos && typeof paso.botones_titulos === 'object' ? paso.botones_titulos : {};
  return (config.botones || []).slice(0, MAX_BOTONES).map((b) => {
    const t = String(titulos[b.clave] || '').trim();
    return t ? { ...b, titulo: t } : b;
  });
}

const REMATE_DEFECTO = '¿Te gustaría pedir 1, 2 o 3 unidades? 😊';

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

function normalizarPasos(pasos) {
  const lista = Array.isArray(pasos) ? pasos : [];
  const recortada = lista.slice(0, MAX_PASOS);
  const out = recortada.map((p, i) => {
    const minutos = Math.round(Number(p?.minutos));
    if (!Number.isFinite(minutos) || minutos < 5 || minutos > 3 * 1440) {
      throw error(`El recordatorio ${i + 1} necesita un tiempo entre 5 minutos y 3 días`);
    }
    const mensaje = String(p?.mensaje || '').trim();
    if (mensaje.length > MAX_CUERPO) {
      throw error(`El mensaje del recordatorio ${i + 1} supera ${MAX_CUERPO} caracteres`);
    }
    const plantilla = normalizarPlantilla(p?.plantilla);
    const botones_titulos = {};
    if (p?.botones_titulos && typeof p.botones_titulos === 'object') {
      for (const [clave, titulo] of Object.entries(p.botones_titulos)) {
        const t = String(titulo || '').trim();
        if (!t) continue;
        if ([...t].length > MAX_TITULO) {
          throw error(`El botón «${t}» del recordatorio ${i + 1} supera ${MAX_TITULO} caracteres (límite de WhatsApp)`);
        }
        botones_titulos[String(clave).slice(0, 40)] = t;
      }
    }
    const fueraDeVentana = acumuladoHasta(recortada, i) > LIMITE_VENTANA_MIN;
    if (fueraDeVentana && !plantilla) {
      throw error(
        `El recordatorio ${i + 1} llegaría más de 24 h después del último mensaje del cliente; ` +
          'WhatsApp solo permite plantillas aprobadas ahí. Elige una plantilla para ese recordatorio o acorta los tiempos.',
      );
    }
    if (!fueraDeVentana && !mensaje) throw error(`El recordatorio ${i + 1} no tiene mensaje`);
    return {
      minutos,
      mensaje,
      con_imagen: p?.con_imagen !== false && p?.con_imagen !== 0,
      con_botones: p?.con_botones !== false && p?.con_botones !== 0,
      ...(Object.keys(botones_titulos).length ? { botones_titulos } : {}),
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

function normalizarBotones(botones) {
  const lista = Array.isArray(botones) && botones.length ? botones : BOTONES_DEFECTO;
  const vistos = new Set();
  const out = lista.slice(0, MAX_BOTONES).map((b, i) => {
    const titulo = String(b?.titulo || '').trim();
    if (!titulo) throw error(`El botón ${i + 1} no tiene texto`);
    if ([...titulo].length > MAX_TITULO) {
      throw error(`El botón «${titulo}» supera ${MAX_TITULO} caracteres (límite de WhatsApp)`);
    }
    // Dos acciones nada más: mandar contenido o que el bot siga cerrando la
    // venta como siempre (respuestas rápidas del wizard → IA). 'ia' quedó de
    // la primera versión y se trata como 'cerrar'.
    const accion = b?.accion === 'bloque' ? 'bloque' : 'cerrar';
    let clave = slug(b?.clave) || slug(titulo) || `boton_${i + 1}`;
    if (vistos.has(clave)) clave = `${clave}_${i + 1}`;
    vistos.add(clave);
    return { clave, titulo, accion };
  });
  return out;
}

function normalizarBloques(bloques, botones) {
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
          throw error(`Un elemento de «${b.titulo}» no tiene archivo`);
        }
        if (tipo === 'text' && !texto) {
          throw error(`Un texto de «${b.titulo}» está vacío`);
        }
        const retraso = Math.round(Number(it?.retraso_seg));
        return {
          tipo,
          url: tipo === 'text' ? null : url,
          texto: texto.slice(0, 4000) || null,
          retraso_seg: Number.isFinite(retraso) ? Math.min(Math.max(retraso, 0), 30) : 2,
        };
      });
    out[b.clave] = {
      items,
      remate: String(bl.remate ?? REMATE_DEFECTO).trim().slice(0, MAX_CUERPO) || null,
    };
  }
  return out;
}

function normalizarConfig(body) {
  const botones = normalizarBotones(body?.botones);
  return {
    activo: body?.activo === false || body?.activo === 0 ? 0 : 1,
    pasos: normalizarPasos(body?.pasos),
    imagen_url: /^https?:\/\//i.test(String(body?.imagen_url || ''))
      ? String(body.imagen_url).trim().slice(0, 1000)
      : null,
    botones,
    bloques: normalizarBloques(body?.bloques, botones),
    estado_destino: body?.estado_destino ? String(body.estado_destino).trim().slice(0, 100) : null,
  };
}

function filaAConfig(fila) {
  if (!fila) return null;
  return {
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
}

/* ── Lecturas ─────────────────────────────────────────────────────────── */

async function productoDe(id_configuracion, id_producto) {
  const [p] = await db.query(
    `SELECT id, nombre, precio, imagen_url, video_url
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
    pasos: PASOS_DEFECTO.map((p) => ({ ...p })),
    imagen_url: null, // null = foto del producto
    botones: BOTONES_DEFECTO.map((b) => ({ ...b })),
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

async function metricasPorProducto(id_configuracion, dias = 30) {
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const filas = await db.query(
    `SELECT id_producto,
            SUM(evento = 'enviado') AS enviados,
            COUNT(DISTINCT CASE WHEN evento = 'enviado' THEN id_cliente_chat_center END) AS clientes,
            COUNT(DISTINCT CASE WHEN evento IN ('respondio','boton') THEN id_cliente_chat_center END) AS respondieron,
            COUNT(DISTINCT CASE WHEN evento = 'boton' AND detalle = 'opiniones' THEN id_cliente_chat_center END) AS opiniones,
            COUNT(DISTINCT CASE WHEN evento = 'boton' AND detalle = 'quiero' THEN id_cliente_chat_center END) AS quiero,
            COUNT(DISTINCT CASE WHEN evento IN ('cierre_ia','cierre_flujo') THEN id_cliente_chat_center END) AS cierres,
            MAX(CASE WHEN evento = 'enviado' THEN created_at END) AS ultimo_envio
       FROM remarketing_producto_eventos
      WHERE id_configuracion = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ${d} DAY)
      GROUP BY id_producto`,
    { replacements: [id_configuracion], type: T.SELECT },
  );
  const out = new Map();
  for (const f of filas) {
    out.set(Number(f.id_producto), {
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
        botones: c ? leerJson(c.botones, []).map((b) => b.titulo) : [],
        actualizado: c?.updated_at || null,
        metricas: m,
      };
    }),
  };
}

async function obtener(id_configuracion, id_producto) {
  const producto = await productoDe(id_configuracion, id_producto);
  if (!producto) throw error('Producto no encontrado', 404);
  const config = await configDeProducto(id_configuracion, id_producto);
  const metricas = await metricasPorProducto(id_configuracion, 30);
  const columnas = await columnasDe(id_configuracion);
  return {
    producto,
    config: config || configPorDefecto(producto, columnas),
    existe: !!config,
    metricas: metricas.get(Number(id_producto)) || null,
    columnas,
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

/** Media de los bloques (capturas de opiniones, fotos, video, PDF). */
async function subirMedia({ id_configuracion, buffer, originalname, mimetype }) {
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

  const imagen = paso.con_imagen ? config.imagen_url || producto.imagen_url || null : null;
  const botones = paso.con_botones ? botonesDelPaso(config, paso) : [];

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
function interpretarBotonProducto(interactive) {
  const rep = interactive?.button_reply || interactive?.list_reply;
  const id = String(rep?.id || '');
  if (!id.startsWith(PREFIJO_BOTON)) return null;
  const m = id.slice(PREFIJO_BOTON.length).match(/^(\d+)_([a-z0-9_]+)$/);
  if (!m) return null;
  return { id_pendiente: Number(m[1]), clave: m[2], titulo: String(rep?.title || '').trim() };
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
  id_pendiente,
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
  const [pend] = await db.query(
    `SELECT id, id_cliente_chat_center, id_remarketing_producto, id_producto, paso_producto
       FROM remarketing_pendientes WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id_pendiente, id_configuracion], type: T.SELECT },
  );
  if (!pend || Number(pend.id_cliente_chat_center) !== Number(id_cliente) || !pend.id_remarketing_producto) {
    return nada;
  }
  const config = await cargarConfig(pend.id_remarketing_producto);
  const producto = await productoDe(id_configuracion, pend.id_producto);
  if (!config || !producto) return nada;
  const boton = config.botones.find((b) => b.clave === clave) || { clave, titulo, accion: 'cerrar' };
  const base = {
    id_configuracion,
    id_producto: producto.id,
    id_remarketing_producto: config.id,
    id_cliente_chat_center: id_cliente,
    id_pendiente: pend.id,
    paso: pend.paso_producto,
  };
  await registrarEvento({ ...base, evento: 'boton', detalle: boton.clave });

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
    const bloque = config.bloques?.[boton.clave];
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
        await registrarEvento({ ...base, evento: 'bloque_vacio', detalle: boton.clave });
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
      await registrarEvento({ ...base, evento: 'bloque', detalle: `${boton.clave}:${n}` });
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

  // «Sí, lo quiero» (o cualquier botón sin bloque): el bot sigue cerrando
  // la venta por el camino de siempre (respuestas rápidas del wizard → IA),
  // con el producto ya sembrado y la pista de que el cliente ya decidió.
  // Si el producto tiene un embudo por pasos activo, intentarPasoFlujo lo
  // retoma solo en el webhook; aquí no se arranca nada.
  await registrarEvento({ ...base, evento: 'cierre_ia', detalle: boton.clave });
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
  const p = config.pasos[paso - 1] || config.pasos[0];
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

  const texto = rellenar(p.mensaje, { nombre: 'Daniela', producto: producto.nombre, precio: fmtPrecio(producto.precio) }).slice(0, MAX_CUERPO);
  const imagen = p.con_imagen ? config.imagen_url || producto.imagen_url || null : null;
  const botones = p.con_botones ? botonesDelPaso(config, p) : [];
  const interactive = {
    type: 'button',
    body: { text: texto },
    action: {
      buttons: botones.map((b) => ({ type: 'reply', reply: { id: `${PREFIJO_BOTON}0_${b.clave}`, title: b.titulo } })),
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
    return { ok: true, wamid: resp.data?.messages?.[0]?.id || null, texto };
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
  PASOS_DEFECTO,
  LIMITE_VENTANA_MIN,
  normalizarConfig,
  validarPlantillasDePasos,
  acumuladoHasta,
  cuentaEnPiloto,
  rellenar,
  normalizarConfig,
  validarPlantillasDePasos,
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
};
