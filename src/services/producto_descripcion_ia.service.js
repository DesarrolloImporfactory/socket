// services/producto_descripcion_ia.service.js
// Redacta la descripción de un producto o servicio a partir de lo poco que el
// usuario ya escribió en el modal (nombre, tipo, categoría) y, si la subió, de
// la foto del producto.
//
// Usa la MISMA api_key_openai que el negocio ya tiene conectada en Asistentes
// (configuraciones.api_key_openai). No hay key de plataforma ni fallback a
// process.env: si el cliente no conectó OpenAI, la función no corre y el front
// ni siquiera muestra el botón. El gasto es de su cuenta, igual que el bot.
//
// Modelo gpt-4o-mini y endpoint /v1/responses: lo mismo que ya usa
// utils/openia/describirImagen.js, así que soporta visión sin contrato aparte.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const { db } = require('../database/config');

const MODELO = 'gpt-4o-mini';
const TIMEOUT_MS = 60000;
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;

/* Hosts desde los que se acepta descargar la imagen cuando llega como URL.
   La URL viaja en el request, así que sin lista el servidor haría la petición
   a donde le digan (SSRF): un http://169.254.169.254 devolvería credenciales
   de la instancia. Estos son los CDNs donde realmente viven las fotos de
   producto: las nuestras, las de Dropi y las del uploader. */
const HOSTS_IMAGEN_PERMITIDOS = [
  'imporfactory.app',
  'cloudfront.net',
  'amazonaws.com',
  'dropi.co',
  'dropi.com',
  'dropi.mx',
];

const PROMPT_SISTEMA = `Redactas fichas de venta para negocios que venden por WhatsApp con pago contra entrega.

La ficha cumple dos papeles a la vez: el vendedor se la envía tal cual al cliente, y el asistente automático la lee para responder preguntas. Por eso tiene que verse atractiva y estar bien organizada, pero sin afirmar nada que no se pueda sostener.

FORMATO EXACTO. Respétalo línea por línea:

<uno o dos emojis> <NOMBRE DEL PRODUCTO EN MAYÚSCULAS> – <PROMESA PRINCIPAL EN MAYÚSCULAS>

<Pregunta que describa el problema que el cliente vive hoy> <uno o dos emojis>
<Una o dos líneas presentando el producto como la opción para resolver eso.>

<emoji> <TÍTULO DEL BENEFICIO EN MAYÚSCULAS>
<Una o dos líneas explicando ese beneficio en concreto.>

<emoji> <TÍTULO DEL SIGUIENTE BENEFICIO EN MAYÚSCULAS>
<Una o dos líneas.>

<... entre 4 y 6 bloques como esos, cada uno con su propio emoji, separados por una línea en blanco ...>

🌟 <Una sola línea de cierre que resuma el resultado que el cliente busca.>

Reglas de estilo:
- Un emoji por bloque, elegido según el tema de ese bloque (nunca el mismo dos veces). Como mucho dos emojis en el título y dos en la pregunta inicial.
- Los títulos de bloque van SIEMPRE en mayúsculas y sin dos puntos al final.
- Los emojis hacen de viñeta: NO uses "-", "•", "*", "**", "#" ni ningún otro marcador. Nada de markdown.
- Español neutro, tuteando al cliente. Entre 200 y 320 palabras en total.
- Uno de los bloques debe decir para quién es ideal el producto.
- Si lo que describes es un servicio y no un producto, uno de los bloques explica en qué consiste la sesión.

Reglas de contenido que no puedes romper:
- Habla SIEMPRE en términos prudentes: "ayuda a", "puede ayudar a", "contribuye a", "es una opción ideal para", "mejora la apariencia de". NUNCA uses "cura", "elimina", "garantiza", "resultados asegurados" ni plazos de tiempo ("en 7 días").
- NO inventes medidas, materiales, ingredientes, componentes, marcas, capacidades, certificaciones, garantías, tiempos de entrega ni estudios científicos. Solo puedes usar lo que venga en los datos o lo que se vea claramente en la foto.
- NO menciones el precio, promociones ni descuentos: el precio lo maneja el sistema aparte y cambia.
- Si los datos son muy pocos, escribe menos bloques antes que rellenar con datos inventados.
- Responde SOLO con la ficha. Nada de introducciones, notas ni comentarios tuyos.`;

/**
 * Lee la API key de OpenAI del negocio. null si no la tiene conectada.
 */
async function obtenerApiKeyOpenAI(id_configuracion) {
  const [row] = await db.query(
    'SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1',
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const key = String(row?.api_key_openai || '').trim();
  return key || null;
}

function hostPermitido(hostname) {
  const host = String(hostname || '').toLowerCase();
  return HOSTS_IMAGEN_PERMITIDOS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );
}

/**
 * Convierte la foto del producto en un data URL para mandársela al modelo.
 * Devuelve null ante cualquier problema: la descripción se genera igual solo
 * con el texto, que es preferible a fallar toda la petición por una imagen.
 */
async function construirDataUrlImagen({ archivo, imagen_url }) {
  try {
    // Foto recién elegida en el modal: llega en memoria, sin haberse guardado.
    if (archivo?.buffer?.length) {
      if (archivo.buffer.length > MAX_BYTES_IMAGEN) return null;
      const mime = archivo.mimetype || 'image/jpeg';
      return `data:${mime};base64,${archivo.buffer.toString('base64')}`;
    }

    // Producto que se está editando: la imagen ya está publicada.
    if (!imagen_url) return null;

    const url = new URL(String(imagen_url));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!hostPermitido(url.hostname)) {
      console.log(`[DESC_IA] host de imagen no permitido: ${url.hostname}`);
      return null;
    }

    const resp = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: MAX_BYTES_IMAGEN,
      maxRedirects: 2,
    });

    const mime = resp.headers['content-type'] || 'image/jpeg';
    if (!mime.startsWith('image/')) return null;

    return `data:${mime};base64,${Buffer.from(resp.data).toString('base64')}`;
  } catch (err) {
    console.log(`[DESC_IA] no se pudo preparar la imagen: ${err.message}`);
    return null;
  }
}

/**
 * Arma el bloque de datos que ve el modelo. Solo entra lo que tiene valor:
 * un campo vacío como "Categoría: " lo único que hace es invitarlo a rellenar.
 */
function construirDatos({ nombre, tipo, categoria, material, borrador }) {
  const esServicio = String(tipo || '').startsWith('ser');
  const lineas = [
    `Tipo: ${esServicio ? 'servicio (se agenda una cita)' : 'producto físico (se entrega al cliente)'}`,
    `Nombre: ${nombre}`,
  ];

  if (categoria) lineas.push(`Categoría: ${categoria}`);
  if (material)
    lineas.push(`Ficha técnica o material de referencia: ${material}`);

  if (borrador) {
    lineas.push(
      '',
      'El vendedor ya escribió estas notas. Son la fuente de verdad: respétalas, ' +
        'corrígeles la redacción y ordénalas en el formato pedido, sin agregarles datos nuevos:',
      borrador,
    );
  }

  return lineas.join('\n');
}

/**
 * Genera la descripción. Lanza Error con .codigo cuando el problema es del
 * negocio (sin key, key revocada) para que el controlador lo traduzca.
 */
async function generarDescripcion({
  id_configuracion,
  nombre,
  tipo,
  categoria,
  material,
  borrador,
  imagen_url,
  archivo,
}) {
  const apiKey = await obtenerApiKeyOpenAI(id_configuracion);
  if (!apiKey) {
    const err = new Error(
      'Este negocio todavía no tiene conectada una API Key de OpenAI. ' +
        'Conéctala en Asistentes para usar la redacción automática.',
    );
    err.codigo = 'OPENAI_KEY_MISSING';
    throw err;
  }

  const dataUrl = await construirDataUrlImagen({ archivo, imagen_url });

  const contenido = [
    {
      type: 'input_text',
      text:
        construirDatos({ nombre, tipo, categoria, material, borrador }) +
        (dataUrl
          ? '\n\nAdjunto la foto real del producto: úsala para describir lo que se ve (forma, color, presentación, texto visible en el empaque). No describas la foto en sí ni el fondo.'
          : ''),
    },
  ];
  if (dataUrl) {
    /* 'high' y no 'low': la regla de no inventar deja al modelo con lo que
       lea en la etiqueta como única fuente de datos concretos (presentación,
       contenido, variante). Con 'low' la imagen se reduce, ese texto se vuelve
       ilegible y la ficha sale toda en generalidades. */
    contenido.push({ type: 'input_image', image_url: dataUrl, detail: 'high' });
  }

  let data;
  try {
    ({ data } = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: MODELO,
        instructions: PROMPT_SISTEMA,
        input: [{ role: 'user', content: contenido }],
        // La ficha con bloques ronda las 300 palabras y los emojis gastan
        // tokens aparte: con el tope viejo (700) se cortaba a mitad del último
        // beneficio y llegaba sin la línea de cierre.
        temperature: 0.7,
        max_output_tokens: 1200,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      },
    ));
  } catch (e) {
    const status = e?.response?.status;
    const detalle = e?.response?.data?.error?.message || e.message;
    console.error(`[DESC_IA] OpenAI ${status || ''} — ${detalle}`);

    if (status === 401) {
      const err = new Error(
        'Tu API Key de OpenAI no es válida o fue revocada. Revísala en Asistentes.',
      );
      err.codigo = 'OPENAI_KEY_INVALID';
      throw err;
    }
    if (status === 429) {
      const err = new Error(
        'Tu cuenta de OpenAI no tiene saldo o llegó a su límite de uso.',
      );
      err.codigo = 'OPENAI_RATE_LIMIT';
      throw err;
    }
    const err = new Error(
      'OpenAI no respondió. Intenta de nuevo en un momento.',
    );
    err.codigo = 'OPENAI_ERROR';
    throw err;
  }

  const mensaje = (data?.output || []).find((i) => i.type === 'message');
  const texto =
    mensaje?.content?.find((c) => c.type === 'output_text')?.text ||
    data?.output_text ||
    '';

  /* Limpieza: pese al prompt, el modelo a veces devuelve la ficha envuelta en
     comillas o con negritas de markdown, y eso se guarda tal cual en la BD y
     después el bot se lo lee al cliente con los asteriscos incluidos. */
  const limpio = texto
    .trim()
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .trim();

  if (!limpio) {
    const err = new Error(
      'La IA devolvió una respuesta vacía. Intenta de nuevo.',
    );
    err.codigo = 'OPENAI_EMPTY';
    throw err;
  }

  return { descripcion: limpio, uso_imagen: Boolean(dataUrl) };
}

module.exports = { generarDescripcion, obtenerApiKeyOpenAI };
