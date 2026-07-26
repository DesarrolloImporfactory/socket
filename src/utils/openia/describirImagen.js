// utils/openia/describirImagen.js
// Convierte una imagen que envía el cliente en una descripción de texto, para
// que la IA del kanban pueda "leerla".
//
// Es el equivalente visual de la transcripción de audios: la imagen se vuelve
// texto y entra al pipeline como si el cliente lo hubiera escrito. Así no hay
// que tocar kanban_ia.service.js ni los prompts de los asistentes.
//
// Dos entradas según el canal:
//   - describirImagenDesdeArchivo(rutaPublica)  → WhatsApp (archivo local)
//   - describirImagenDesdeUrl(url)              → Instagram / Messenger (CDN Meta)
//
// Usa gpt-4o-mini, el mismo modelo que ya corre el kanban: soporta visión, así
// que no hace falta ninguna key ni contrato adicional.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DOMINIO_PUBLICO = 'https://chat.imporfactory.app';
const MODELO = 'gpt-4o-mini';

// Tope de seguridad: Meta permite imágenes de varios MB y base64 infla ~33%.
const MAX_BYTES = 8 * 1024 * 1024;

// El prompt está orientado al negocio (venta con pago contra entrega), no a
// describir la foto "en general". Lo importante son los datos accionables.
//
// La regla de "ilegible" es deliberada: es preferible que el bot admita que no
// puede leer un comprobante a que invente un monto y dé por pagada una venta.
const PROMPT_VISION = `Describes imágenes que los clientes envían por chat a una tienda que vende con pago contra entrega.

Responde SIEMPRE en español y con este formato exacto:
[IMAGEN: <tipo>] <descripción útil>

Donde <tipo> es uno de: comprobante_pago, producto, direccion, documento, otro.

Reglas por tipo:
- comprobante_pago: transcribe banco, monto, fecha y número de referencia tal como aparecen. NO afirmes que el pago es válido ni que fue recibido: solo transcribe lo que se ve.
- producto: describe qué producto aparece y cualquier marca o texto visible.
- direccion: transcribe la dirección tal cual aparece.
- documento: transcribe nombre y número de documento.
- otro: descríbela en una sola frase.

Reglas generales:
- Transcribe literalmente el texto visible que sea relevante.
- NO inventes datos. Si algo está borroso, cortado o no se distingue, escribe "ilegible" en ese dato.
- Máximo 80 palabras.`;

function mimePorExtension(ruta) {
  const ext = path.extname(ruta || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// ══════════════════════════════════════════════════════════════
// Llamada única a OpenAI. Recibe la imagen ya en data URL.
// ══════════════════════════════════════════════════════════════
async function pedirDescripcion(dataUrl, apiKeyOpenAI, etiquetaLog) {
  const res = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: MODELO,
      instructions: PROMPT_VISION,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: dataUrl,
              // 'high' es necesario para poder leer comprobantes y direcciones;
              // con 'low' la imagen se reduce y el texto se vuelve ilegible.
              detail: 'high',
            },
          ],
        },
      ],
      max_output_tokens: 300,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKeyOpenAI}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    },
  );

  const items = res.data?.output || [];
  const mensaje = items.find((i) => i.type === 'message');
  const texto =
    mensaje?.content?.find((c) => c.type === 'output_text')?.text || '';

  const limpio = texto.trim();
  if (!limpio) {
    console.log(`[${etiquetaLog}] respuesta de visión vacía`);
    return null;
  }
  return limpio;
}

// ══════════════════════════════════════════════════════════════
// WhatsApp: la imagen ya fue descargada por descargarImagenWhatsapp y vive en
// src/uploads/... Se lee del disco (no por URL) por la misma razón que el
// audio: en desarrollo el archivo es local pero la URL apunta a producción.
// ══════════════════════════════════════════════════════════════
async function describirImagenDesdeArchivo(rutaArchivo, apiKeyOpenAI) {
  try {
    if (!rutaArchivo || !apiKeyOpenAI) return null;

    const rutaRelativa = rutaArchivo.replace(DOMINIO_PUBLICO, '');
    // __dirname = <raiz>/src/utils/openia → '..','..' deja <raiz>/src, que es
    // donde vive la carpeta uploads (igual que en la función de audio).
    const rutaAbsoluta = path.join(__dirname, '..', '..', rutaRelativa);

    const stat = await fs.stat(rutaAbsoluta);
    if (stat.size > MAX_BYTES) {
      console.log(`[VISION][WA] imagen demasiado grande (${stat.size} bytes)`);
      return null;
    }

    const b64 = await fs.readFile(rutaAbsoluta, { encoding: 'base64' });
    const dataUrl = `data:${mimePorExtension(rutaAbsoluta)};base64,${b64}`;

    return await pedirDescripcion(dataUrl, apiKeyOpenAI, 'VISION][WA');
  } catch (err) {
    console.log(
      `[VISION][WA][ERROR] ${err?.response?.data?.error?.message || err.message}`,
    );
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Instagram / Messenger: la imagen vive en el CDN de Meta. Se descarga a
// memoria (igual que hace la transcripción de audio de esos canales) y se
// manda en base64, para no depender de que OpenAI pueda alcanzar una URL
// firmada que además expira.
// ══════════════════════════════════════════════════════════════
async function describirImagenDesdeUrl(url, apiKeyOpenAI, canal = 'IG') {
  try {
    if (!url || !apiKeyOpenAI) return null;

    const imgRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_BYTES,
    });

    const mime = imgRes.headers['content-type'] || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      console.log(`[VISION][${canal}] el adjunto no es una imagen (${mime})`);
      return null;
    }

    const b64 = Buffer.from(imgRes.data).toString('base64');
    return await pedirDescripcion(
      `data:${mime};base64,${b64}`,
      apiKeyOpenAI,
      `VISION][${canal}`,
    );
  } catch (err) {
    console.log(
      `[VISION][${canal}][ERROR] ${err?.response?.data?.error?.message || err.message}`,
    );
    return null;
  }
}

module.exports = {
  describirImagenDesdeArchivo,
  describirImagenDesdeUrl,
  PROMPT_VISION,
};
