// services/producto_wizard.service.js
// Wizard de producto (vista /productos2): configuración por producto del
// primer mensaje fijo, las respuestas rápidas y la generación con IA (textos e
// imágenes) usando la API key de OpenAI del propio negocio.
//
// Todo lo que llama a OpenAI acá es "de configuración" (lo dispara el negocio
// desde el panel), no del runtime del chat. El runtime vive en
// producto_wizard_runtime.service.js y NO gasta tokens salvo cuando cae a la IA.

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const FormDataLib = require('form-data');

const { db } = require('../database/config');
const ProductosWizard = require('../models/productos_wizard.model');
const ProductosChatCenter = require('../models/productos_chat_center.model');
const {
  obtenerApiKeyOpenAI,
} = require('./producto_descripcion_ia.service');
const { uploadToUploader } = require('../utils/whatsappTemplate.helpers');
const {
  syncCatalogoTodasColumnasConfig,
} = require('./syncCatalogoKanbanColumna.service');
const {
  MAX_IMAGENES,
  MAX_VIDEOS,
  leerJson,
  combosValidos,
  fmtPrecio,
  componerMensajeInicial,
  limitarMedia,
  mediaFijaDelProducto,
  paqueteMedia,
  preguntaGanchoPorDefecto,
} = require('../utils/wizardProducto/componerMensajeInicial');

// ── Modelos ────────────────────────────────────────────────────
// gpt-5-mini es de razonamiento: los tokens de razonamiento descuentan del
// tope de salida, así que el tope va alto y si vuelve vacío se reintenta.
const MODELO_TEXTOS = process.env.OPENAI_WIZARD_MODEL || 'gpt-5-mini';
const MODELO_TEXTOS_RESPALDO = 'gpt-4o-mini';
// Spec: gpt-image-2 con la key de la tienda. Si la cuenta no lo tiene
// habilitado (model_not_found) se cae a gpt-image-1 y se recuerda en memoria
// para no pagar el intento fallido en cada generación.
const MODELO_IMAGEN = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const MODELO_IMAGEN_RESPALDO = 'gpt-image-1';
let modeloImagenVivo = MODELO_IMAGEN;

const TIMEOUT_TEXTOS_MS = 90000;
const TIMEOUT_IMAGEN_MS = 180000;

// Mismo criterio que producto_descripcion_ia: solo se descargan imágenes de
// los CDNs donde realmente viven las fotos (evita SSRF con URLs arbitrarias).
const HOSTS_IMAGEN_PERMITIDOS = [
  'imporfactory.app',
  'cloudfront.net',
  'amazonaws.com',
  'dropi.co',
  'dropi.com',
  'dropi.mx',
];

const DOMINIO_UPLOADS = 'https://chat.imporfactory.app';
const DIR_IMAGEN_LOCAL = path.join(
  __dirname,
  '..',
  'uploads',
  'productos',
  'imagen',
);
const DIR_VIDEO_LOCAL = path.join(
  __dirname,
  '..',
  'uploads',
  'productos',
  'video',
);

function errorCon(mensaje, codigo, status = 400) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  e.statusCode = status;
  return e;
}

function aJsonTexto(v) {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   Lectura
   ══════════════════════════════════════════════════════════════ */

/** Fila del producto (con el JSON de combos ya como array). */
async function cargarProducto(id_producto, id_configuracion) {
  const p = await ProductosChatCenter.findOne({
    where: { id: id_producto, id_configuracion },
  });
  if (!p) return null;
  const plano = p.toJSON();
  // combos_producto es BLOB: el Buffer se convierte acá para que el front y el
  // composer lo vean como array.
  plano.combos_producto = leerJson(plano.combos_producto, []);
  return plano;
}

/** Variedades activas de un producto variable (color, talla…). */
async function cargarVariaciones(producto) {
  if (!producto || Number(producto.es_variable) !== 1) return [];
  if (Array.isArray(producto.variaciones)) return producto.variaciones;
  try {
    return await db.query(
      `SELECT id, dropi_variation_id, atributo, valor, stock,
              precio_proveedor, precio_sugerido
         FROM productos_variaciones
        WHERE id_producto = ? AND activo = 1
        ORDER BY id`,
      { replacements: [producto.id], type: db.QueryTypes.SELECT },
    );
  } catch {
    return [];
  }
}

function resumenVariaciones(variaciones) {
  return (variaciones || [])
    .map((v) => {
      const stock = v.stock != null ? ` (stock ${v.stock})` : '';
      return `${v.atributo ? `${v.atributo}: ` : ''}${v.valor}${stock}`;
    })
    .join(', ');
}

function serializarWizard(w) {
  if (!w) return null;
  const plano = typeof w.toJSON === 'function' ? w.toJSON() : { ...w };
  plano.bullets = leerJson(plano.bullets_json, []);
  plano.media = limitarMedia(leerJson(plano.media_json, []));
  plano.respuestas_rapidas = leerJson(plano.respuestas_rapidas_json, []);
  delete plano.bullets_json;
  delete plano.media_json;
  delete plano.respuestas_rapidas_json;
  return plano;
}

/**
 * Listado para la vista: todos los productos de la cuenta con su estado de
 * wizard. Una sola query con LEFT JOIN.
 */
async function listarProductosConWizard(id_configuracion) {
  const filas = await db.query(
    `SELECT p.id, p.nombre, p.descripcion, p.precio, p.stock, p.imagen_url,
            p.video_url, p.combos_producto, p.tipo, p.external_source,
            p.external_id, p.id_dropi, p.es_privado, p.fecha_creacion,
            p.fecha_actualizacion,
            w.id AS wizard_id, w.tipo_venta, w.wizard_completado, w.activo,
            w.usar_respuestas_rapidas, w.updated_at AS wizard_updated_at,
            w.media_json, w.respuestas_rapidas_json, w.mensaje_inicial
       FROM productos_chat_center p
       LEFT JOIN productos_wizard w ON w.id_producto = p.id
      WHERE p.id_configuracion = ? AND p.eliminado = 0
      ORDER BY (w.wizard_completado IS NULL OR w.wizard_completado = 0) DESC,
               p.fecha_actualizacion DESC, p.id DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return filas.map((f) => {
    const media = limitarMedia(leerJson(f.media_json, []));
    const faqs = leerJson(f.respuestas_rapidas_json, []);
    return {
      id: f.id,
      nombre: f.nombre,
      descripcion: f.descripcion,
      precio: f.precio,
      stock: f.stock,
      imagen_url: f.imagen_url,
      video_url: f.video_url,
      combos_producto: leerJson(f.combos_producto, []),
      combos_validos: combosValidos(f.combos_producto),
      tipo: f.tipo,
      external_source: f.external_source,
      external_id: f.external_id,
      id_dropi: f.id_dropi,
      es_privado: f.es_privado,
      fecha_actualizacion: f.fecha_actualizacion,
      wizard: f.wizard_id
        ? {
            id: f.wizard_id,
            tipo_venta: f.tipo_venta,
            wizard_completado: Number(f.wizard_completado) === 1,
            activo: Number(f.activo) === 1,
            usar_respuestas_rapidas: Number(f.usar_respuestas_rapidas) === 1,
            updated_at: f.wizard_updated_at,
            // Lo que el cliente RECIBE: la foto y el video del catálogo van
            // primero en el paquete; media_json son solo las adicionales.
            // Contar solo extras mostraba "0 img" en productos con foto.
            n_imagenes: Math.min(
              MAX_IMAGENES,
              (f.imagen_url ? 1 : 0) +
                media.filter((m) => m.tipo === 'image').length,
            ),
            n_videos: Math.min(
              MAX_VIDEOS,
              (f.video_url ? 1 : 0) +
                media.filter((m) => m.tipo === 'video').length,
            ),
            n_respuestas_rapidas: Array.isArray(faqs) ? faqs.length : 0,
            tiene_mensaje: Boolean((f.mensaje_inicial || '').trim()),
          }
        : null,
    };
  });
}

/**
 * Producto + wizard (o los valores iniciales si todavía no existe), listo para
 * abrir el wizard en el front.
 */
async function obtenerWizard(id_producto, id_configuracion) {
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);

  const fila = await ProductosWizard.findOne({
    where: { id_producto, id_configuracion },
  });
  const wizard = serializarWizard(fila);

  // Ficha completa para el paso 1: variantes (si es variable) y categoría.
  producto.variaciones = await cargarVariaciones(producto);
  producto.categoria_nombre = null;
  if (producto.id_categoria) {
    try {
      const [cat] = await db.query(
        `SELECT nombre FROM categorias_chat_center WHERE id = ? LIMIT 1`,
        { replacements: [producto.id_categoria], type: db.QueryTypes.SELECT },
      );
      producto.categoria_nombre = cat?.nombre || null;
    } catch {
      producto.categoria_nombre = null;
    }
  }

  // Valores iniciales. Un servicio arranca como "servicio" (cierra por agenda,
  // sin unidades ni línea de envío).
  const esServicio = String(producto.tipo || '')
    .toLowerCase()
    .startsWith('ser');
  const inicial = {
    tipo_venta: esServicio ? 'servicio' : 'fisico',
    problema_resuelve: '',
    antes_despues: '',
    beneficios: '',
    descripcion_ia: '',
    pregunta_gancho: '',
    intro_mensaje: '',
    linea_envio: esServicio ? '' : '🚚 Envío gratis y pagas al recibir',
    bullets: [],
    media: [],
    respuestas_rapidas: [],
    mensaje_inicial: '',
    usar_respuestas_rapidas: 1,
    wizard_completado: 0,
    activo: 1,
  };

  return {
    producto,
    wizard: wizard || inicial,
    existe: Boolean(wizard),
    // La foto y el video del catálogo van siempre primero en el paquete; el
    // wizard solo agrega imágenes adicionales.
    media_fija: mediaFijaDelProducto(producto),
    paquete: paqueteMedia({ producto, wizard: fila ? fila.toJSON() : null }),
    combos_validos: combosValidos(producto.combos_producto),
    precio_formateado: fmtPrecio(producto.precio),
    mensaje_sugerido: componerMensajeInicial({
      producto,
      wizard: wizard || inicial,
    }),
  };
}

/* ══════════════════════════════════════════════════════════════
   Escritura
   ══════════════════════════════════════════════════════════════ */

const CAMPOS_TEXTO = [
  'problema_resuelve',
  'antes_despues',
  'beneficios',
  'descripcion_ia',
  'pregunta_gancho',
  'intro_mensaje',
  'linea_envio',
  'mensaje_inicial',
];

function limpiarFaqs(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((f) => ({
      pregunta: String(f?.pregunta || '').trim(),
      respuesta: String(f?.respuesta || '').trim(),
      claves: Array.isArray(f?.claves)
        ? f.claves.map((c) => String(c || '').trim()).filter(Boolean)
        : [],
      activa: f?.activa === 0 || f?.activa === false ? 0 : 1,
    }))
    .filter((f) => f.pregunta && f.respuesta)
    .slice(0, 20);
}

/**
 * Upsert del wizard. Si `mensaje_inicial` llega vacío se compone con el
 * composer (misma función que usa el runtime). `wizard_completado` solo se
 * puede poner en 1 si hay mensaje y media.
 */
async function guardarWizard(id_producto, id_configuracion, payload = {}) {
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);

  const datos = { id_producto, id_configuracion };

  if (payload.tipo_venta) {
    datos.tipo_venta = ['natural_salud', 'servicio'].includes(payload.tipo_venta)
      ? payload.tipo_venta
      : 'fisico';
  }
  for (const campo of CAMPOS_TEXTO) {
    if (payload[campo] !== undefined) {
      datos[campo] =
        payload[campo] === null ? null : String(payload[campo]).trim();
    }
  }
  if (payload.bullets !== undefined) {
    datos.bullets_json = aJsonTexto(
      (Array.isArray(payload.bullets) ? payload.bullets : [])
        .map((b) => String(b || '').trim())
        .filter(Boolean)
        .slice(0, 6),
    );
  }
  if (payload.media !== undefined) {
    datos.media_json = aJsonTexto(limitarMedia(payload.media));
  }
  if (payload.respuestas_rapidas !== undefined) {
    datos.respuestas_rapidas_json = aJsonTexto(
      limpiarFaqs(payload.respuestas_rapidas),
    );
  }
  if (payload.usar_respuestas_rapidas !== undefined) {
    datos.usar_respuestas_rapidas = payload.usar_respuestas_rapidas ? 1 : 0;
  }
  if (payload.activo !== undefined) datos.activo = payload.activo ? 1 : 0;

  let fila = await ProductosWizard.findOne({
    where: { id_producto, id_configuracion },
  });

  // Mensaje: si no lo mandaron (o viene vacío) se compone con lo que quede.
  const base = fila ? fila.toJSON() : {};
  const combinado = { ...base, ...datos };
  if (!String(combinado.mensaje_inicial || '').trim()) {
    datos.mensaje_inicial = componerMensajeInicial({
      producto,
      wizard: combinado,
    });
    combinado.mensaje_inicial = datos.mensaje_inicial;
  }

  if (payload.wizard_completado !== undefined) {
    const quiereCompletar = Boolean(payload.wizard_completado);
    if (quiereCompletar) {
      const media = paqueteMedia({ producto, wizard: combinado }).todas;
      const faltan = [];
      if (!String(combinado.mensaje_inicial || '').trim()) {
        faltan.push('el mensaje inicial');
      }
      if (!media.length) {
        faltan.push('al menos una foto o video (del producto o adicional)');
      }
      if (faltan.length) {
        throw errorCon(
          `Para activar el producto falta ${faltan.join(' y ')}.`,
          'WIZARD_INCOMPLETO',
        );
      }
    }
    datos.wizard_completado = quiereCompletar ? 1 : 0;
  }

  datos.updated_at = new Date();

  if (fila) {
    await fila.update(datos);
  } else {
    fila = await ProductosWizard.create(datos);
  }
  fila = await ProductosWizard.findByPk(fila.id);

  const wizard = serializarWizard(fila);
  return {
    producto,
    wizard,
    paquete: paqueteMedia({ producto, wizard: fila.toJSON() }),
  };
}

async function eliminarWizard(id_producto, id_configuracion) {
  const n = await ProductosWizard.destroy({
    where: { id_producto, id_configuracion },
  });
  return n > 0;
}

/** Preview sin guardar: el mismo composer del runtime. */
async function previewMensaje(id_producto, id_configuracion, wizardInput = {}) {
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);
  const wizard = {
    ...wizardInput,
    media_json: aJsonTexto(limitarMedia(wizardInput.media || [])),
  };
  return {
    mensaje: componerMensajeInicial({ producto, wizard }),
    paquete: paqueteMedia({ producto, wizard }),
    combos_validos: combosValidos(producto.combos_producto),
    pregunta_por_defecto: preguntaGanchoPorDefecto(
      wizardInput.tipo_venta,
      producto,
    ),
  };
}

/* ══════════════════════════════════════════════════════════════
   OpenAI — helpers
   ══════════════════════════════════════════════════════════════ */

async function apiKeyObligatoria(id_configuracion) {
  const key = await obtenerApiKeyOpenAI(id_configuracion);
  if (!key) {
    throw errorCon(
      'Conecta tu API key de OpenAI en Asistentes para generar con IA.',
      'OPENAI_KEY_MISSING',
      400,
    );
  }
  return key;
}

function traducirErrorOpenAI(e) {
  const status = e?.response?.status;
  const detalle = e?.response?.data?.error?.message || e.message;
  console.error(`[WIZARD_IA] OpenAI ${status || ''} — ${detalle}`);
  if (status === 401) {
    return errorCon(
      'Tu API Key de OpenAI no es válida o fue revocada. Revísala en Asistentes.',
      'OPENAI_KEY_INVALID',
      400,
    );
  }
  if (status === 429) {
    return errorCon(
      'Tu cuenta de OpenAI no tiene saldo o llegó a su límite de uso.',
      'OPENAI_RATE_LIMIT',
      400,
    );
  }
  if (status === 403) {
    return errorCon(
      `OpenAI rechazó la operación: ${detalle}`,
      'OPENAI_FORBIDDEN',
      400,
    );
  }
  return errorCon(
    `OpenAI no respondió: ${detalle || 'intenta de nuevo en un momento.'}`,
    'OPENAI_ERROR',
    502,
  );
}

function esModeloNoDisponible(e) {
  const status = e?.response?.status;
  const msg = String(e?.response?.data?.error?.message || '').toLowerCase();
  const code = String(e?.response?.data?.error?.code || '').toLowerCase();
  return (
    code === 'model_not_found' ||
    (status === 404 && /model/.test(msg)) ||
    (status === 400 && /model|does not exist|not supported|unsupported/.test(msg) && /model/.test(msg))
  );
}

function esGpt5(model) {
  return /^gpt-5/i.test(String(model || ''));
}

/** Saca el texto de salida de una respuesta de /v1/responses. */
function textoDeResponses(data) {
  const items = data?.output || [];
  const msg = items.find((it) => it.type === 'message');
  const c = msg?.content?.find((x) => x.type === 'output_text');
  return c?.text || '';
}

/**
 * Llama /v1/responses con salida JSON estricta. Maneja las dos trampas de los
 * modelos de razonamiento: salida vacía por tope (status incomplete) y modelo
 * no habilitado en la cuenta (cae al de respaldo).
 */
async function responsesJson({
  apiKey,
  model,
  instructions,
  input,
  schema,
  nombreSchema,
  maxTokens = 3000,
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const armarBody = (m, tope, effort) => {
    const body = {
      model: m,
      instructions,
      input,
      max_output_tokens: tope,
      text: {
        format: {
          type: 'json_schema',
          name: nombreSchema,
          strict: true,
          schema,
        },
      },
    };
    if (esGpt5(m)) body.reasoning = { effort };
    else body.temperature = 0.6;
    return body;
  };

  let modelo = model;
  let tope = maxTokens;
  let effort = 'low';
  let intentos = 0;
  let data;

  while (intentos < 3) {
    intentos += 1;
    try {
      ({ data } = await axios.post(
        'https://api.openai.com/v1/responses',
        armarBody(modelo, tope, effort),
        { headers, timeout: TIMEOUT_TEXTOS_MS },
      ));
    } catch (e) {
      if (esModeloNoDisponible(e) && modelo !== MODELO_TEXTOS_RESPALDO) {
        console.warn(
          `[WIZARD_IA] modelo ${modelo} no disponible, reintento con ${MODELO_TEXTOS_RESPALDO}`,
        );
        modelo = MODELO_TEXTOS_RESPALDO;
        continue;
      }
      throw traducirErrorOpenAI(e);
    }

    const texto = textoDeResponses(data);
    if (texto.trim()) {
      try {
        return {
          json: JSON.parse(texto),
          modelo,
          total_tokens: data?.usage?.total_tokens || 0,
        };
      } catch {
        // JSON roto: con strict no debería pasar; se reintenta una vez.
      }
    }
    // Vacío o incompleto: más tope y menos razonamiento.
    tope = Math.min(tope * 2, 12000);
    effort = 'minimal';
  }
  throw errorCon(
    'La IA devolvió una respuesta vacía. Intenta de nuevo.',
    'OPENAI_EMPTY',
    502,
  );
}

/* ══════════════════════════════════════════════════════════════
   Generación de textos (paso 3)
   ══════════════════════════════════════════════════════════════ */

const SCHEMA_TEXTOS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro_mensaje: { type: 'string' },
    descripcion_ia: { type: 'string' },
    pregunta_gancho: { type: 'string' },
    bullets_beneficios: { type: 'array', items: { type: 'string' } },
    texto_antes: { type: 'string' },
    texto_despues: { type: 'string' },
    respuestas_rapidas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pregunta: { type: 'string' },
          respuesta: { type: 'string' },
          claves: { type: 'array', items: { type: 'string' } },
        },
        required: ['pregunta', 'respuesta', 'claves'],
      },
    },
    prompt_imagen_beneficios: { type: 'string' },
    prompt_imagen_antes_despues: { type: 'string' },
    prompt_imagen_logistica: { type: 'string' },
  },
  required: [
    'intro_mensaje',
    'descripcion_ia',
    'pregunta_gancho',
    'bullets_beneficios',
    'texto_antes',
    'texto_despues',
    'respuestas_rapidas',
    'prompt_imagen_beneficios',
    'prompt_imagen_antes_despues',
    'prompt_imagen_logistica',
  ],
};

const INSTRUCCIONES_TEXTOS = `Eres el redactor de un negocio que vende por WhatsApp con pago contra entrega en Ecuador. A partir de la ficha cruda de un producto armas las piezas de su "primer mensaje fijo" y sus respuestas frecuentes.

Estilo: español neutro de Ecuador, tuteo (tú, tienes, llevas — nunca "vos/tenés/llevás"), frases cortas, cercano y concreto, emojis con moderación (máximo uno por frase), SIN markdown (nada de *, #, -, listas con guiones).

La ficha puede traer respuestas del negocio (qué problema resuelve, antes/después, beneficios) o venir sin ellas: si dicen "(no respondió)", deduce TODO del nombre, la descripción del catálogo, la categoría y las variedades del producto — es el caso normal, no un error. Nunca menciones que faltó información.

Devuelves SOLO el JSON pedido. Cada campo:
- intro_mensaje: 1 o 2 frases (máximo 220 caracteres) con las que abre el mensaje: empatiza con el problema y presenta el producto como la solución. NO incluyas precios ni preguntas: eso lo agrega el sistema después.
- descripcion_ia: ficha de 4 a 7 frases que leerá un asistente automático para responder preguntas. Incluye para qué sirve, cómo se usa, qué incluye y los beneficios concretos. Solo datos que estén en la ficha cruda; si algo no está, no lo inventes.
- pregunta_gancho: UNA pregunta para cerrar el mensaje, SIN precios (los precios ya van listados en líneas aparte justo arriba; repetirlos la vuelve ilegible). Pregunta solo por cantidades/variedad (ej. "¿Te llevas 1, 2 o 3 unidades?"), nunca "2 por $60, 3 por $70…". Si tipo_venta es "natural_salud", pregunta por el síntoma o molestia principal (ej. "Para recomendarte bien: ¿cuál es tu molestia principal: dolor, inflamación o ardor?"). Si es "fisico", pregunta cuántas unidades quiere usando las cantidades de los combos que te doy (ej. "¿Te llevas 1 o 2 unidades?"); si no hay combos, pregunta si lo envía a domicilio o retira en agencia. Si es "servicio", pregunta para qué fecha u horario quiere agendarlo (o en qué sede), nunca por unidades.
- Si tipo_venta es "servicio": no hables de envío, unidades, combos ni "pagas al recibir"; habla de agendar, duración, qué incluye y cómo se reserva. Los prompts de imagen deben mostrar el servicio (persona atendida, resultado, lugar) y la pieza "logistica" pasa a ser "Cómo reservar" con textos "AGENDA TU CITA", "ATENCIÓN PERSONALIZADA", "GARANTÍA".
- bullets_beneficios: exactamente 4 beneficios de máximo 6 palabras cada uno, sin emoji.
- texto_antes / texto_despues: una frase corta cada una (máximo 80 caracteres) para una imagen de antes/después.
- respuestas_rapidas: entre 6 y 10 preguntas que un cliente hace por WhatsApp sobre ESTE producto y que se pueden contestar con la ficha (uso, para quién sirve, qué incluye, materiales, tallas/medidas, duración, garantía, envío y pago contra entrega, tiempo de entrega, cómo se usa, diferencias entre combos). Cada respuesta: 1 a 3 frases, lista para enviar tal cual, en tuteo, y TERMINA SIEMPRE con una pregunta corta de cierre de venta ligada a lo que se acaba de responder, que empuje el pedido (ej. tras responder tallas: "¿Cuál te aparto?"; tras responder envío: "¿Te lo envío con pago contra entrega?"; tras responder uso: "¿Te confirmo tu pedido?"). Varía la pregunta entre respuestas: nunca la misma dos veces. La respuesta informa Y cierra: contestar sin rematar mata la venta. "claves": de 3 a 6 palabras clave (sustantivos o verbos, sin tildes, en minúscula, sin artículos) que identifican esa pregunta y NO aparecen en las otras. Si la ficha no trae el dato, NO inventes la respuesta: omite esa pregunta.
- prompt_imagen_*: tres prompts en inglés para un modelo de imagen, uno por pieza: (beneficios) el producto en primer plano con los 4 beneficios como texto grande y legible en español; (antes_despues) composición dividida antes/después con las dos frases en español; (logistica) el producto con los textos "ENVÍO GRATIS", "PAGAS AL RECIBIR" y "GARANTÍA" en español. Especifica estilo fotográfico publicitario, fondo limpio, texto en español exacto entre comillas.

Reglas obligatorias:
- Nunca afirmes que el producto cura, trata, elimina o previene enfermedades. Usa "ayuda a", "alivia la molestia", "contribuye a". Meta rechaza claims médicos.
- Nunca menciones la palabra "combo" si la ficha dice que no hay combos válidos.
- Si hay variedades (color, talla, modelo), la pregunta de cierre puede pedir la variedad además de la cantidad, y conviene una respuesta rápida que las liste.
- No inventes envío, garantía ni tiempos: si la ficha no los trae, usa lo genérico del negocio ("envío a todo el país, pagas al recibir") sin cifras.`;

async function generarTextos({ id_configuracion, id_producto, wizardInput }) {
  const apiKey = await apiKeyObligatoria(id_configuracion);
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);

  const w = wizardInput || {};
  const tipo_venta = ['natural_salud', 'servicio'].includes(w.tipo_venta)
    ? w.tipo_venta
    : 'fisico';
  const combos = combosValidos(producto.combos_producto);
  const variaciones = await cargarVariaciones(producto);

  const ficha = [
    `Nombre: ${producto.nombre}`,
    `Precio unitario: ${fmtPrecio(producto.precio)}`,
    combos.length
      ? `Combos válidos: ${combos
          .map((c) => `${c.cantidad} por ${fmtPrecio(c.precio)}`)
          .join(', ')}`
      : 'Combos válidos: NINGUNO (no menciones combos)',
    `Tipo de venta: ${tipo_venta}`,
    `Categoría/tipo: ${producto.tipo || 'producto'}`,
    variaciones.length
      ? `Variedades disponibles (el cliente elige una): ${resumenVariaciones(variaciones)}`
      : '',
    producto.descripcion
      ? `Descripción actual del catálogo:\n${String(producto.descripcion).slice(0, 2500)}`
      : 'Descripción actual del catálogo: (vacía)',
    `¿Qué problema resuelve? (respuesta del negocio):\n${w.problema_resuelve || '(no respondió)'}`,
    `¿Cuál es el antes y el después? (respuesta del negocio):\n${w.antes_despues || '(no respondió)'}`,
    `Beneficios y características (respuesta del negocio):\n${w.beneficios || '(no respondió)'}`,
    w.linea_envio ? `Línea de envío que usa el negocio: ${w.linea_envio}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { json, modelo, total_tokens } = await responsesJson({
    apiKey,
    model: MODELO_TEXTOS,
    instructions: INSTRUCCIONES_TEXTOS,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: `FICHA CRUDA DEL PRODUCTO:\n\n${ficha}` }],
      },
    ],
    schema: SCHEMA_TEXTOS,
    nombreSchema: 'wizard_producto_textos',
    maxTokens: 4000,
  });

  const bullets = (json.bullets_beneficios || [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const respuestas_rapidas = limpiarFaqs(json.respuestas_rapidas || []);

  const textos = {
    intro_mensaje: String(json.intro_mensaje || '').trim(),
    descripcion_ia: String(json.descripcion_ia || '').trim(),
    pregunta_gancho:
      String(json.pregunta_gancho || '').trim() ||
      preguntaGanchoPorDefecto(tipo_venta, producto),
    bullets,
    texto_antes: String(json.texto_antes || '').trim(),
    texto_despues: String(json.texto_despues || '').trim(),
    respuestas_rapidas,
    prompts_imagen: {
      beneficios: String(json.prompt_imagen_beneficios || '').trim(),
      antes_despues: String(json.prompt_imagen_antes_despues || '').trim(),
      logistica: String(json.prompt_imagen_logistica || '').trim(),
    },
  };

  const mensaje_inicial = componerMensajeInicial({
    producto,
    wizard: { ...w, ...textos, tipo_venta },
  });

  /* Una sola descripción: la del catálogo. La generada se guarda directo en
     productos_chat_center.descripcion (lo que el bot ya lee en el flujo
     normal) y se resincroniza el catálogo del kanban, igual que cuando se
     edita desde el formulario de productos.

     PERO solo cuando el producto NO tiene descripción propia (o el caller lo
     pide explícito con aplicar_descripcion: true). Antes pisaba SIEMPRE:
     quien generaba su descripción en el paso 1 y luego tocaba "Completar con
     IA" en el paso 2 la perdía sin darse cuenta — al reabrir el modal
     aparecía "la vieja" y parecía que el guardado no funcionaba. */
  const tieneDescripcion =
    String(producto.descripcion || '').trim().length > 0;
  let descripcion_actualizada = false;
  if (
    textos.descripcion_ia &&
    (w.aplicar_descripcion === true ||
      (!tieneDescripcion && w.aplicar_descripcion !== false))
  ) {
    try {
      await ProductosChatCenter.update(
        { descripcion: textos.descripcion_ia, fecha_actualizacion: new Date() },
        { where: { id: id_producto, id_configuracion } },
      );
      descripcion_actualizada = true;
      syncCatalogoTodasColumnasConfig(id_configuracion).catch(() => {});
    } catch (e) {
      console.warn(`[WIZARD_IA] no se pudo guardar la descripción: ${e.message}`);
    }
  }

  return {
    ...textos,
    descripcion: textos.descripcion_ia,
    descripcion_actualizada,
    mensaje_inicial,
    modelo,
    total_tokens,
  };
}

/**
 * Usa una imagen (p. ej. una generada con IA) como foto principal del
 * producto: es la que el bot manda en el flujo normal y la primera del
 * paquete. Misma fuente para todos los caminos.
 */
async function fotoPrincipal({ id_producto, id_configuracion, url }) {
  const limpia = String(url || '').trim();
  if (!/^https?:\/\//i.test(limpia) || limpia.length > 512) {
    throw errorCon('La URL de la imagen no es válida.', 'URL_INVALIDA');
  }
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);
  const anterior = String(producto.imagen_url || '').trim();
  await ProductosChatCenter.update(
    { imagen_url: limpia, fecha_actualizacion: new Date() },
    { where: { id: id_producto, id_configuracion } },
  );
  syncCatalogoTodasColumnasConfig(id_configuracion).catch(() => {});
  /* Adicionales del wizard: la nueva principal sale de ahí (ya va primera como
     foto del producto) y la principal ANTERIOR no se pierde: pasa a ser la
     primera adicional. Si no hay cupo (3 imágenes), limitarMedia la mantiene y
     descarta la última. */
  let fila = await ProductosWizard.findOne({
    where: { id_producto, id_configuracion },
  });
  const extrasPrevias = fila ? leerJson(fila.media_json, []) : [];
  const extras = limitarMedia([
    ...(anterior && anterior !== limpia
      ? [{ tipo: 'image', url: anterior, origen: 'subida', etiqueta: 'Foto anterior' }]
      : []),
    ...(Array.isArray(extrasPrevias) ? extrasPrevias : []).filter(
      (m) => m && m.url !== limpia && m.url !== anterior,
    ),
  ]);
  if (fila) {
    await fila.update({ media_json: aJsonTexto(extras), updated_at: new Date() });
  } else if (extras.length) {
    fila = await ProductosWizard.create({
      id_producto,
      id_configuracion,
      media_json: aJsonTexto(extras),
    });
  }
  return { imagen_url: limpia, anterior_conservada: Boolean(anterior && anterior !== limpia) };
}

/* ══════════════════════════════════════════════════════════════
   Subida de archivos (imagen / video) — uploader, con respaldo local
   ══════════════════════════════════════════════════════════════ */

async function guardarLocal(buffer, ext, esVideo) {
  const dir = esVideo ? DIR_VIDEO_LOCAL : DIR_IMAGEN_LOCAL;
  await fs.promises.mkdir(dir, { recursive: true });
  const nombre = `${uuidv4()}${ext}`;
  await fs.promises.writeFile(path.join(dir, nombre), buffer);
  return `${DOMINIO_UPLOADS}/uploads/productos/${esVideo ? 'video' : 'imagen'}/${nombre}`;
}

/**
 * Sube un buffer y devuelve una URL pública. Primero el uploader (CDN, sirve
 * desde cualquier servidor: dev o prod); si falla, disco local como hace el
 * módulo de productos.
 */
async function subirBuffer({ buffer, mimetype, nombre, carpeta }) {
  const esVideo = /^video\//.test(mimetype || '');
  try {
    const { fileUrl } = await uploadToUploader({
      buffer,
      originalname: nombre,
      mimetype,
      folder: carpeta || 'productos-wizard',
    });
    if (fileUrl) return fileUrl;
  } catch (e) {
    console.warn(`[WIZARD_UPLOAD] uploader falló (${e.message}); guardo local`);
  }
  const ext = path.extname(nombre || '') || (esVideo ? '.mp4' : '.jpg');
  return guardarLocal(buffer, ext, esVideo);
}

/**
 * Media subida por el negocio desde el wizard. Las imágenes se normalizan a
 * JPG (WhatsApp acepta JPG/PNG; así se evitan HEIC/WEBP raros); el video va
 * tal cual.
 */
async function subirMedia({ id_configuracion, file }) {
  if (!file?.buffer) throw errorCon('No llegó ningún archivo.', 'SIN_ARCHIVO');
  const esVideo = /^video\//.test(file.mimetype);
  if (esVideo) {
    const url = await subirBuffer({
      buffer: file.buffer,
      mimetype: file.mimetype,
      nombre: file.originalname || 'video.mp4',
      carpeta: `productos-wizard/${id_configuracion}`,
    });
    return { tipo: 'video', url, origen: 'subida' };
  }
  let jpg;
  try {
    jpg = await sharp(file.buffer)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw errorCon('La imagen no se pudo leer. Usa JPG, PNG o WEBP.', 'IMAGEN_INVALIDA');
  }
  const url = await subirBuffer({
    buffer: jpg,
    mimetype: 'image/jpeg',
    nombre: `${path.parse(file.originalname || 'imagen').name}.jpg`,
    carpeta: `productos-wizard/${id_configuracion}`,
  });
  return { tipo: 'image', url, origen: 'subida' };
}

/* ══════════════════════════════════════════════════════════════
   Generación de imágenes (paso 3) — con la key del negocio
   ══════════════════════════════════════════════════════════════ */

function hostPermitido(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return HOSTS_IMAGEN_PERMITIDOS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Descarga la foto del producto para usarla de referencia (edición). */
async function descargarReferencia(url) {
  if (!url || !hostPermitido(url)) return null;
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 8 * 1024 * 1024,
    });
    const buf = Buffer.from(resp.data);
    // A PNG cuadrado-compatible y liviano: el endpoint de edición acepta
    // png/jpg/webp hasta 50MB, pero no hace falta mandar más de 1024px.
    return await sharp(buf)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .png()
      .toBuffer();
  } catch (e) {
    console.warn(`[WIZARD_IMG] no pude bajar la referencia: ${e.message}`);
    return null;
  }
}

const PIEZAS = {
  beneficios: {
    etiqueta: 'Beneficios',
    armar: ({ producto, bullets }) =>
      `Advertising product photo for WhatsApp sales. The product "${producto.nombre}" is the hero, centered, studio lighting, clean light background. Around it, four short benefit labels in Spanish rendered as large, crisp, perfectly legible text: ${bullets
        .map((b) => `"${b}"`)
        .join(', ')}. No other text. Modern e-commerce style, high contrast, square composition.`,
  },
  antes_despues: {
    etiqueta: 'Antes / después',
    armar: ({ producto, texto_antes, texto_despues }) =>
      `Split composition "ANTES" (left) and "DESPUÉS" (right) for the product "${producto.nombre}". Left side muted and dull with the Spanish caption "${texto_antes || 'Antes'}"; right side bright and positive with the Spanish caption "${texto_despues || 'Después'}". Headers "ANTES" and "DESPUÉS" in large legible Spanish text. Tasteful, realistic, no exaggerated or medical claims, no body transformations. Square composition.`,
  },
  logistica: {
    etiqueta: 'Logística',
    armar: ({ producto }) =>
      `E-commerce promotional image for "${producto.nombre}": the product on the left, and on the right three bold badges with exact Spanish text "ENVÍO GRATIS", "PAGAS AL RECIBIR", "GARANTÍA", each with a small icon (truck, cash, shield). Clean background, brand-neutral colors, large legible text, square composition.`,
  },
  libre: {
    etiqueta: 'Personalizada',
    armar: ({ producto, instrucciones_extra }) =>
      `Advertising image for the product "${producto.nombre}" to be sent by WhatsApp. ${instrucciones_extra || ''} Clean composition, any text must be in Spanish and perfectly legible.`,
  },
};

async function pedirImagen({ apiKey, prompt, referencia }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const intentar = async (model) => {
    if (referencia) {
      const form = new FormDataLib();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', '1024x1024');
      form.append('image[]', referencia, {
        filename: 'referencia.png',
        contentType: 'image/png',
      });
      const { data } = await axios.post(
        'https://api.openai.com/v1/images/edits',
        form,
        {
          headers: { ...headers, ...form.getHeaders() },
          timeout: TIMEOUT_IMAGEN_MS,
          maxBodyLength: Infinity,
        },
      );
      return data;
    }
    const { data } = await axios.post(
      'https://api.openai.com/v1/images/generations',
      { model, prompt, size: '1024x1024', n: 1 },
      {
        headers: { ...headers, 'Content-Type': 'application/json' },
        timeout: TIMEOUT_IMAGEN_MS,
      },
    );
    return data;
  };

  try {
    return { data: await intentar(modeloImagenVivo), modelo: modeloImagenVivo };
  } catch (e) {
    if (esModeloNoDisponible(e) && modeloImagenVivo !== MODELO_IMAGEN_RESPALDO) {
      console.warn(
        `[WIZARD_IMG] ${modeloImagenVivo} no disponible en esta cuenta; uso ${MODELO_IMAGEN_RESPALDO}`,
      );
      modeloImagenVivo = MODELO_IMAGEN_RESPALDO;
      try {
        return { data: await intentar(modeloImagenVivo), modelo: modeloImagenVivo };
      } catch (e2) {
        throw traducirErrorOpenAI(e2);
      }
    }
    throw traducirErrorOpenAI(e);
  }
}

/**
 * Genera UNA pieza (beneficios | antes_despues | logistica | libre) con la
 * key del negocio. Si el producto tiene foto se usa como referencia (edición)
 * para que la imagen muestre el producto real; si no, generación libre.
 * Devuelve la URL ya subida.
 */
async function generarImagen({
  id_configuracion,
  id_producto,
  tipo = 'beneficios',
  bullets = [],
  texto_antes = '',
  texto_despues = '',
  instrucciones_extra = '',
  prompt_personalizado = '',
  usar_referencia = true,
}) {
  const apiKey = await apiKeyObligatoria(id_configuracion);
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);

  const pieza = PIEZAS[tipo] || PIEZAS.libre;
  const bulletsLimpios = (Array.isArray(bullets) ? bullets : [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  let prompt = String(prompt_personalizado || '').trim();
  if (!prompt) {
    prompt = pieza.armar({
      producto,
      bullets: bulletsLimpios.length
        ? bulletsLimpios
        : ['Calidad garantizada', 'Fácil de usar', 'Envío a todo el país', 'Pago contra entrega'],
      texto_antes,
      texto_despues,
      instrucciones_extra,
    });
  }
  if (tipo === 'antes_despues') {
    prompt += ' Do not depict medical results, weight loss or body changes; keep it illustrative.';
  }

  const referencia = usar_referencia
    ? await descargarReferencia(producto.imagen_url)
    : null;

  const { data, modelo } = await pedirImagen({ apiKey, prompt, referencia });
  const b64 = data?.data?.[0]?.b64_json;
  let buffer;
  if (b64) {
    buffer = Buffer.from(b64, 'base64');
  } else if (data?.data?.[0]?.url) {
    const r = await axios.get(data.data[0].url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    buffer = Buffer.from(r.data);
  } else {
    throw errorCon('OpenAI no devolvió la imagen.', 'OPENAI_EMPTY', 502);
  }

  const jpg = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  const url = await subirBuffer({
    buffer: jpg,
    mimetype: 'image/jpeg',
    nombre: `ia-${tipo}-${id_producto}.jpg`,
    carpeta: `productos-wizard/${id_configuracion}`,
  });

  return {
    tipo: 'image',
    url,
    origen: 'ia',
    etiqueta: pieza.etiqueta,
    pieza: tipo,
    modelo,
    con_referencia: Boolean(referencia),
    prompt,
  };
}

/* ══════════════════════════════════════════════════════════════
   Simulador del paso 4: una conversación real por producto
   ══════════════════════════════════════════════════════════════ */

/**
 * Responde un turno del simulador como lo haría el bot EN VIVO para este
 * producto, con lo que el negocio tiene en pantalla (aunque no haya guardado):
 *   1. si la pregunta calza con una respuesta rápida → esa, sin IA;
 *   2. si no (o si quiere comprar) → la IA de la columna inicial de la cuenta,
 *      con la ficha del producto como prefacio (igual que el motor) y el
 *      mensaje fijo ya "dicho" como primer turno del asistente. El hilo se
 *      mantiene con previous_response_id, así cada producto tiene su propia
 *      conversación de prueba. No se envía nada por WhatsApp ni se graba en
 *      mensajes_clientes; sí gasta tokens de la cuenta (como el chat de prueba).
 */
async function simularTurno({
  id_configuracion,
  id_producto,
  mensaje,
  wizardInput = {},
  mensaje_fijo = '',
  previous_response_id = null,
  // Columna que atiende ahora en el hilo simulado. Arranca en la inicial y,
  // cuando una respuesta dispara un cambiar_estado, el front manda la destino
  // (igual que en producción: el siguiente turno lo contesta ESA columna).
  id_columna = null,
  // Conversación simulada hasta ahora: [{ rol: 'cliente'|'bot', texto }]. Con
  // ella se arma la FICHA DEL PEDIDO (qué datos ya dio el cliente y cuáles
  // faltan) igual que en producción, donde se lee de mensajes_clientes.
  historial = [],
}) {
  const texto = String(mensaje || '').trim();
  if (!texto) throw errorCon('Escribe un mensaje para simular.', 'SIN_MENSAJE');
  const producto = await cargarProducto(id_producto, id_configuracion);
  if (!producto) throw errorCon('Producto no encontrado.', 'NOT_FOUND', 404);
  producto.variaciones = await cargarVariaciones(producto);

  const {
    elegirRespuestaRapida,
    pareceIntencionCompra,
  } = require('../utils/wizardProducto/respuestasRapidas');
  const faqs = limpiarFaqs(wizardInput.respuestas_rapidas || []);
  const usaRapidas =
    wizardInput.usar_respuestas_rapidas === undefined ||
    Boolean(Number(wizardInput.usar_respuestas_rapidas));

  // 1) Respuesta rápida (nunca cuando el cliente está comprando: ahí sigue la IA)
  const compra = pareceIntencionCompra(texto);
  const matchFaq = usaRapidas
    ? elegirRespuestaRapida(texto, faqs, { ignorarCompra: true })
    : null;
  if (matchFaq && !compra) {
    /* Mismo remate que en producción: si la respuesta no termina preguntando,
       el cierre de venta se agrega aquí también — lo que se prueba en el
       simulador es exactamente lo que le llega al cliente. */
    const {
      conCierreDeVenta,
      semillaCierre,
    } = require('../utils/wizardProducto/cierreVenta');
    return {
      tipo: 'rapida',
      respuesta: conCierreDeVenta(
        matchFaq.faq.respuesta,
        semillaCierre('', matchFaq.indice),
      ),
      responsable: 'IA_respuesta_rapida',
      remitente: 'Respuesta rápida',
      tokens: 0,
      previous_response_id,
    };
  }
  // Para que el simulador explique por qué no salió la quemada.
  const faq_omitida = matchFaq && compra ? matchFaq.faq.pregunta : null;

  // 2) IA de la columna que atiende (la inicial, o la que siguió el hilo)
  const apiKey = await apiKeyObligatoria(id_configuracion);
  const CAMPOS_COL = `id, nombre, estado_db, instrucciones, modelo, max_tokens, vector_store_id,
              vector_store_docs_id, catalogo_inline, catalogo_inline_tokens, activa_ia`;
  let col = null;
  if (id_columna) {
    [col] =
      (await db.query(
        `SELECT ${CAMPOS_COL} FROM kanban_columnas
          WHERE id = ? AND id_configuracion = ? AND activo = 1 LIMIT 1`,
        { replacements: [id_columna, id_configuracion], type: db.QueryTypes.SELECT },
      )) || [];
  }
  if (!col) {
    [col] =
      (await db.query(
        `SELECT ${CAMPOS_COL} FROM kanban_columnas
          WHERE id_configuracion = ? AND activo = 1
          ORDER BY (LOWER(estado_db) = 'contacto_inicial') DESC, activa_ia DESC, id ASC
          LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      )) || [];
  }
  if (!col) {
    throw errorCon(
      'La cuenta no tiene una columna inicial con asistente configurado (Kanban → Configuración).',
      'SIN_COLUMNA',
    );
  }
  // Columna sin IA: en vivo la atiende una persona, el bot no contesta.
  if (Number(col.activa_ia) !== 1 || !String(col.instrucciones || '').trim()) {
    return {
      tipo: 'humano',
      respuesta: '',
      responsable: null,
      remitente: null,
      columna: col.nombre,
      columna_id: col.id,
      estado_db: col.estado_db,
      tokens: 0,
      acciones_detectadas: [],
      siguiente_columna: null,
      previous_response_id,
    };
  }

  const {
    bloqueWizardParaMotor,
  } = require('./producto_wizard_runtime.service');
  const {
    ejecutarConResponsesAPI,
    limpiarTagsAcciones,
  } = require('./kanban_ia.service');
  const { construirContextoColumna } = require('../utils/contextoColumna');
  const { catalogoInlineActivo } = require('../utils/openia/fileSearch');
  const { limpiarMarkdown } = require('../utils/formatoWhatsapp');

  const wizardLike = {
    tipo_venta: wizardInput.tipo_venta || 'fisico',
    descripcion_ia: wizardInput.descripcion_ia || '',
    bullets_json: aJsonTexto(wizardInput.bullets || []),
    respuestas_rapidas_json: aJsonTexto(faqs),
  };
  // El simulador ve el mismo upsell que el bot en vivo.
  try {
    const { resolverUpsell } = require('../utils/upsellProducto');
    producto.upsell = await resolverUpsell(producto);
  } catch {
    producto.upsell = null;
  }
  const prefacio = bloqueWizardParaMotor({ producto, wizard: wizardLike });

  let bloqueContexto = '';
  let acciones = [];
  try {
    acciones = await db.query(
      `SELECT tipo_accion, config, orden FROM kanban_acciones
        WHERE id_kanban_columna = ? AND activo = 1 ORDER BY orden`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
    bloqueContexto =
      (await construirContextoColumna(id_configuracion, acciones, null, {
        mensaje: texto,
      })) || '';
  } catch {
    bloqueContexto = '';
  }

  /* Redes del cierre, las mismas del motor (kanban_ia paso 6.8 y 10): la ficha
     del pedido se inyecta cuando la conversación está en fase de datos, y el
     cierre se valida contra el resumen. Sin esto el simulador "cerraba" sin
     ciudad/provincia y con un resumen distinto al del prompt. */
  const {
    extraerFichaPedido,
    bloqueFichaPedido,
    completarResumenConFicha,
    nombrePaisDe,
  } = require('../utils/fichaPedido');
  const { motivoCierreInvalido, camposFaltantesCierre } = require('./kanban_ia.service');

  const accCierre = (acciones || [])
    .map((a) => {
      let cfg = a.config;
      if (typeof cfg === 'string') {
        try {
          cfg = JSON.parse(cfg);
        } catch {
          cfg = {};
        }
      }
      return { ...a, cfg: cfg || {} };
    })
    .find((a) => a.tipo_accion === 'cambiar_estado' && a.cfg.estado_destino === 'generar_guia' && a.cfg.trigger);

  const hist = (Array.isArray(historial) ? historial : [])
    .map((h) => ({ rol: h?.rol === 'bot' ? 'bot' : 'cliente', texto: String(h?.texto || '').trim() }))
    .filter((h) => h.texto);
  const itemsTranscript = [
    ...(mensaje_fijo ? [{ rol: 'ASISTENTE', texto: String(mensaje_fijo) }] : []),
    ...hist.map((h) => ({ rol: h.rol === 'bot' ? 'ASISTENTE' : 'CLIENTE', texto: h.texto })),
    { rol: 'CLIENTE', texto },
  ];
  const textosCliente = itemsTranscript.filter((i) => i.rol === 'CLIENTE').map((i) => i.texto);
  const transcriptExterno = {
    transcript: itemsTranscript
      .map((i) => `${i.rol}: ${i.texto.slice(0, i.rol === 'CLIENTE' ? 500 : 300)}`)
      .join('\n')
      .slice(-9000),
    textoCliente: textosCliente.join('\n'),
    items: itemsTranscript,
    firma: `${textosCliente.length}:${texto.length}`,
    nCliente: textosCliente.length,
  };

  let fichaPedido = null;
  let bloqueFicha = '';
  if (accCierre) {
    const PIDE_DATOS =
      /nombre|tel[eé]fono|direcci[oó]n|ciudad|provincia|agencia|servientrega|domicilio|referencia|resumen|pedido/i;
    const ultimosBot = hist.filter((h) => h.rol === 'bot').slice(-3);
    const enFaseDatos =
      ultimosBot.some((h) => PIDE_DATOS.test(h.texto)) ||
      PIDE_DATOS.test(texto) ||
      /\d{9,}/.test(texto);
    if (enFaseDatos) {
      try {
        const [cfgPais] = await db.query(
          `SELECT pais_plantilla, telefono FROM configuraciones WHERE id = ? LIMIT 1`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        fichaPedido = await extraerFichaPedido({
          id_configuracion,
          id_cliente: `sim_${id_configuracion}_${id_producto}`,
          api_key_openai: apiKey,
          paisNombre: nombrePaisDe({ pais_plantilla: cfgPais?.pais_plantilla, telefono: cfgPais?.telefono }),
          transcriptExterno,
        });
        bloqueFicha = bloqueFichaPedido(fichaPedido, { trigger: accCierre.cfg.trigger }) || '';
      } catch {
        fichaPedido = null;
        bloqueFicha = '';
      }
    }
  }

  const catalogoInline = String(col.catalogo_inline || '').trim();
  const usarInline =
    Boolean(catalogoInline) &&
    catalogoInlineActivo(id_configuracion, Number(col.catalogo_inline_tokens || 0));

  /* Nota de rescate (igual que el paso 6.7 del motor): si el turno anterior
     fue un cierre bloqueado, el modelo cree que ya cerró (su resumen quedó en
     el hilo). Sin la nota, al recibir el dato que faltaba dice "hubo un error"
     o vuelve a preguntar lo ya dado. */
  const PREFIJO_PETICION = 'Para confirmar tu pedido, ayúdame con';
  const ultimoBot = [...hist].reverse().find((h) => h.rol === 'bot');
  let notaRescate = '';
  if (accCierre && ultimoBot && ultimoBot.texto.startsWith(PREFIJO_PETICION)) {
    const faltaba = ultimoBot.texto
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, ''))
      .join(' | ');
    notaRescate =
      `⚠️ CIERRE PENDIENTE: tu último resumen de cierre fue RECHAZADO por el sistema porque estaba incompleto` +
      (faltaba ? ` (faltaba: ${faltaba})` : '') +
      `. La venta NO está cerrada, aunque en la conversación parezca que sí.\n` +
      `En cuanto tengas ese dato —revisa la conversación: es probable que el cliente YA lo haya dado— escribe otra vez el resumen COMPLETO del pedido con TODAS sus líneas y el tag ${accCierre.cfg.trigger}, todo en un solo mensaje.\n` +
      `NO le pidas al cliente datos que ya dio, NO le pidas que confirme otra vez si ya confirmó, y NO menciones que hubo un error del sistema.`;
  }

  const instructions = [
    prefacio,
    col.instrucciones,
    usarInline ? catalogoInline : '',
    bloqueContexto,
    notaRescate,
    bloqueFicha,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Primer turno: el mensaje fijo ya fue "dicho" por el asistente.
  const input = previous_response_id
    ? [{ role: 'user', content: texto }]
    : [
        ...(mensaje_fijo
          ? [{ role: 'assistant', content: String(mensaje_fijo) }]
          : []),
        { role: 'user', content: texto },
      ];

  let r;
  try {
    r = await ejecutarConResponsesAPI({
      previous_response_id: previous_response_id || null,
      instructions,
      additional_instructions: null,
      input,
      model: col.modelo || 'gpt-4o-mini',
      max_tokens: col.max_tokens || 500,
      vector_store_id: usarInline ? null : col.vector_store_id || null,
      vector_store_docs_id: col.vector_store_docs_id || null,
      api_key_openai: apiKey,
      id_configuracion,
    });
  } catch (e) {
    throw traducirErrorOpenAI(e);
  }

  let crudo = String(r?.respuesta || '');
  let cierre_bloqueado = null;
  let resumen_completado = [];
  if (accCierre && crudo.toLowerCase().includes(String(accCierre.cfg.trigger).toLowerCase())) {
    if (fichaPedido) {
      const comp = completarResumenConFicha(crudo, fichaPedido);
      if (comp.completados.length) {
        crudo = comp.texto;
        resumen_completado = comp.completados;
      }
    }
    const motivo = motivoCierreInvalido(crudo, fichaPedido);
    if (motivo) {
      // Igual que en vivo: ni cambio de columna ni orden; se piden los datos.
      cierre_bloqueado = motivo;
      const faltan = camposFaltantesCierre(crudo, fichaPedido);
      const PREFIJO = 'Para confirmar tu pedido, ayúdame con';
      crudo =
        faltan.length === 1
          ? `${PREFIJO} este dato 😊:\n${faltan[0]}`
          : `${PREFIJO} estos datos 😊:\n` +
            (faltan.length
              ? faltan.join('\n')
              : '- Nombre completo\n- Teléfono\n- Ciudad y provincia\n' +
                '- Dirección exacta (dos calles y una referencia), o la ' +
                'agencia Servientrega si prefieres retirarlo');
    }
  }
  /* Triggers de las acciones de ESTA columna (cambiar_estado, crear orden…):
     si la respuesta los trae, en vivo el tablero movería la tarjeta y el
     siguiente turno lo contestaría la columna destino. Se devuelve para que el
     simulador haga lo mismo. */
  const textoBajo = crudo.toLowerCase();
  const acciones_detectadas = [];
  for (const ac of acciones) {
    let cfg = ac.config;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = {};
      }
    }
    const trigger = cfg?.trigger;
    if (!trigger || !textoBajo.includes(String(trigger).toLowerCase())) continue;
    acciones_detectadas.push({
      trigger,
      tipo_accion: ac.tipo_accion,
      estado_destino: cfg.estado_destino || null,
    });
  }
  let siguiente_columna = null;
  const destino = acciones_detectadas.find(
    (a) => a.tipo_accion === 'cambiar_estado' && a.estado_destino,
  );
  if (destino) {
    const [colDest] = await db.query(
      `SELECT id, nombre, estado_db, activa_ia FROM kanban_columnas
        WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
        LIMIT 1`,
      {
        replacements: [id_configuracion, destino.estado_destino],
        type: db.QueryTypes.SELECT,
      },
    );
    if (colDest) {
      siguiente_columna = {
        id: colDest.id,
        nombre: colDest.nombre,
        estado_db: colDest.estado_db,
        activa_ia: Number(colDest.activa_ia) === 1,
        genera_guia: /generar_guia|guia|orden/i.test(String(destino.estado_destino)),
      };
    }
  }

  let limpio = limpiarTagsAcciones(crudo);
  try {
    limpio = limpiarMarkdown(limpio);
  } catch {
    /* sin limpieza extra */
  }

  return {
    tipo: 'ia',
    respuesta: limpio.trim(),
    responsable: `IA_${col.nombre}`,
    remitente: `IA ${col.nombre}`,
    columna: col.nombre,
    columna_id: col.id,
    estado_db: col.estado_db,
    modelo: r?.usage?.modelo || col.modelo || null,
    tokens: Number(r?.total_tokens) || 0,
    acciones_detectadas,
    siguiente_columna: cierre_bloqueado ? null : siguiente_columna,
    faq_omitida,
    cierre_bloqueado,
    resumen_completado,
    ficha: fichaPedido
      ? {
          nombre: fichaPedido.nombre,
          telefono: fichaPedido.telefono,
          ciudad: fichaPedido.ciudad,
          provincia: fichaPedido.provincia,
          direccion: fichaPedido.direccion,
          entrega: fichaPedido.entrega,
          cantidad: fichaPedido.cantidad,
        }
      : null,
    previous_response_id: r?.response_id || null,
  };
}

module.exports = {
  simularTurno,
  cargarVariaciones,
  resumenVariaciones,
  listarProductosConWizard,
  obtenerWizard,
  guardarWizard,
  eliminarWizard,
  previewMensaje,
  generarTextos,
  generarImagen,
  fotoPrincipal,
  subirMedia,
  cargarProducto,
  serializarWizard,
};
