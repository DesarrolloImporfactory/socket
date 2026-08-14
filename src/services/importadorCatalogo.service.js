'use strict';

/* Importar un inmueble desde el anuncio que ya está publicado.
   ─────────────────────────────────────────────────────────────
   El flujo entero es: enlace → borrador → una persona revisa → se guarda con el
   formulario de siempre. Este servicio hace el paso del medio y nada más:
   nunca escribe en `productos_chat_center`. Guardar sin que nadie mire es la
   forma más rápida de llenar el catálogo de basura que después el bot cotiza.

   Dos caminos, en este orden:

     1. Extracción estructurada (services/scrapers/anuncios.js). Barata,
        instantánea y sin costo. Cuando el portal expone JSON-LD, sale completa.

     2. Respaldo con IA. Se le da el texto de la página a un modelo con
        `response_format: json_schema` y devuelve los mismos campos. Cuesta unos
        centavos y un par de segundos, pero es lo que hace que esto siga
        funcionando el día que el portal cambie su markup — que va a pasar, sin
        aviso. Solo se usa si la extracción vino pobre.

   El respaldo también acepta texto pegado a mano, sin URL: si un portal bloquea
   la lectura automática, copiar el anuncio y pegarlo da el mismo resultado. */

const axios = require('axios');

const { db } = require('../database/config');
const { leerAnuncio } = require('./scrapers/anuncios');
const { downloadAndConvertToJpgS3 } = require('../utils/imageConverter');
const { obtenerPreset, resolverPreset } = require('../utils/fichaPresets');

/* El schema se arma según el rubro de la cuenta.
   ─────────────────────────────────────────────────────────────
   Lo común a cualquier catálogo —nombre, descripción, precio— va siempre. Lo
   demás lo agrega el preset: pedirle "dormitorios" al anuncio de una freidora
   de aire no es solo inútil, es invitar al modelo a inventar un número para
   llenar el campo.

   Con `strict: true` el modelo no puede devolver otra cosa, así que no hay
   parsing ni validación después. Todos los campos van en `required` porque
   `strict` lo exige, y todos aceptan null: el modelo deja vacío lo que no
   encuentra, que es justo lo que queremos —un dato inventado en una ficha es
   un problema, no un detalle. */
function construirSchema(preset) {
  const base = {
    nombre: {
      type: ['string', 'null'],
      description: 'Título corto y reconocible, como lo pondría quien lo vende',
    },
    descripcion: { type: ['string', 'null'] },
    precio: {
      type: ['number', 'null'],
      description: 'Solo el número, sin símbolo ni separadores de miles',
    },
  };

  const def = obtenerPreset(preset);

  if (def?.usa_ubicacion) {
    base.direccion = { type: ['string', 'null'] };
    base.sector = { type: ['string', 'null'], description: 'Barrio o sector' };
    base.ciudad = { type: ['string', 'null'] };
  }

  for (const campo of def?.campos || []) {
    base[campo.clave] = {
      type: ['string', 'null'],
      description: `${campo.etiqueta}${campo.ejemplo ? ` (ej. ${campo.ejemplo})` : ''}`,
    };
  }

  return {
    name: 'item_del_anuncio',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: base,
      required: Object.keys(base),
    },
  };
}

function construirInstrucciones(preset) {
  const def = obtenerPreset(preset);
  const que = def ? def.nombre.toLowerCase() : 'un producto';

  return [
    `Extraes los datos de un anuncio de ${que} y los devuelves estructurados.`,
    '',
    'Reglas:',
    '- Usa SOLO lo que diga el anuncio. Si un dato no aparece, va null.',
    '- Está prohibido deducir. Si no dice un dato, no lo calcules a partir de',
    '  otro ni lo estimes por lo que sería razonable: va null.',
    '- El precio es solo el número. "USD 145.000" → 145000. Si hay varios',
    '  precios, toma el principal del anuncio (no el tachado ni el de cuotas).',
    '- Las medidas van con su unidad tal como aparecen ("120 m²").',
    '- El nombre debe servir para reconocerlo en una lista. Escríbelo como un',
    '  título normal, con mayúscula inicial y en los nombres propios. Ni TODO',
    '  EN MAYÚSCULAS ni todo en minúsculas, y sin signos de admiración.',
    '- La descripción es la del anuncio, limpia de teléfonos, nombres de otros',
    '  vendedores, códigos internos del portal y textos de navegación.',
  ].join('\n');
}

async function apiKeyDe(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return cfg?.api_key_openai || null;
}

/* Con la API de chat completions y no con Assistants: acá no hay conversación
   ni thread que mantener, es una extracción de un solo turno. */
async function extraerConIA({ texto, api_key, preset, modelo = 'gpt-4o-mini' }) {
  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: modelo,
      messages: [
        { role: 'system', content: construirInstrucciones(preset) },
        { role: 'user', content: texto.slice(0, 12000) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: construirSchema(preset),
      },
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${api_key}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    },
  );

  const crudo = data?.choices?.[0]?.message?.content;
  if (!crudo) return null;
  // `strict: true` garantiza el shape, así que esto no debería fallar nunca.
  return JSON.parse(crudo);
}

/* Se quedan las dos: la que ya estaba (si venía de la extracción) manda, y la
   de la IA rellena lo que faltaba. Nunca al revés — lo que el portal declara en
   su JSON-LD es más confiable que lo que un modelo leyó de la prosa. */
const completar = (base, extra) => {
  const vacio = (v) => v === null || v === undefined || v === '';
  const salida = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (!vacio(v) && vacio(salida[k])) salida[k] = v;
  }
  return salida;
};

/**
 * @param {object} p
 * @param {number} p.id_configuracion
 * @param {string} [p.url]     enlace del anuncio
 * @param {string} [p.texto]   texto pegado a mano, cuando el portal bloquea
 * @param {boolean} [p.descargar_imagenes]  copiar las fotos a nuestro storage
 */
async function importarDesdeUrl({
  id_configuracion,
  url,
  texto,
  descargar_imagenes = true,
}) {
  if (!url && !texto) {
    return { ok: false, motivo: 'Pega el enlace del anuncio o su texto' };
  }

  /* El rubro de la cuenta decide qué se le pide al anuncio y cómo se carga lo
     que salga. Sin rubro —una tienda de dropshipping— esto sigue funcionando:
     se importa nombre, descripción, precio y foto, que es exactamente lo que
     necesita para vender, y no se le inventan campos de otro negocio. */
  const preset = await resolverPreset(db, id_configuracion);
  const def = obtenerPreset(preset);

  let base = {};
  let imagenes = [];
  let textoPagina = texto || '';
  let fuente = 'texto-pegado';
  let completitud = 0;

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, motivo: 'El enlace tiene que empezar con http o https' };
    }

    const leido = await leerAnuncio(url);

    /* El enlace no dio nada. Da igual el motivo —403 de Cloudflare, la página
       caída, un dominio mal escrito—: desde donde está el usuario, todos son
       el mismo problema y todos tienen el mismo remedio, que es copiar la
       publicación a mano. Se marca para que la pantalla lo guíe en vez de
       dejarlo con un mensaje de error y nada que hacer. */
    if (!leido.ok) {
      return { ...leido, requiere_texto: true, enlace: url };
    }

    const b = leido.borrador;
    imagenes = b.imagenes || [];
    textoPagina = leido.texto_pagina || '';
    fuente = leido.fuente;
    completitud = leido.completitud;

    base = {
      nombre: b.nombre,
      descripcion: b.descripcion,
      precio: b.precio,
      direccion: b.direccion,
      sector: b.sector,
      ciudad: b.ciudad,
      latitud: b.latitud,
      longitud: b.longitud,
      galeria_url: b.galeria_url,
      ...b.atributos,
    };
  }

  /* El respaldo. Se dispara cuando la extracción vino a menos de dos tercios, o
     cuando no hubo extracción porque el texto llegó pegado a mano. Sin api key
     de la cuenta simplemente no corre: se devuelve lo que se haya podido leer y
     se avisa, en vez de fallar. */
  let usoIA = false;
  let avisoIA = null;

  if (textoPagina && (completitud < 0.67 || !url)) {
    const api_key = await apiKeyDe(id_configuracion);
    if (!api_key) {
      avisoIA =
        'La lectura salió incompleta y la cuenta no tiene OpenAI conectado ' +
        'para completarla. Revisa y completa los campos a mano.';
    } else {
      try {
        const extra = await extraerConIA({
          texto: textoPagina,
          api_key,
          preset,
        });
        if (extra) {
          base = completar(base, extra);
          usoIA = true;
        }
      } catch (err) {
        avisoIA = `No se pudo completar con IA: ${err.response?.data?.error?.message || err.message}`;
      }
    }
  }

  if (!base.nombre) {
    /* Sin api key la IA no corrió, y pegar el texto tampoco la va a hacer
       correr: ese camino también pasa por ella. Ahí el motivo real es la key
       que falta, y mandarlo a copiar sería mandarlo a chocar contra lo mismo. */
    if (avisoIA) return { ok: false, motivo: avisoIA };

    /* Con enlace: la página respondió pero no había un ítem adentro. Pasa con
       los muros de login —MercadoLibre devuelve 200 con "ingresa a tu cuenta"—
       y cada vez que un portal cambia su markup. El navegador del usuario SÍ
       ve la página, así que la salida es que la copie. */
    if (url) {
      return {
        ok: false,
        requiere_texto: true,
        enlace: url,
        motivo:
          'La página respondió, pero no se encontró la publicación dentro ' +
          '(suele ser un muro de inicio de sesión).',
      };
    }

    // Con texto pegado: de verdad no había un ítem en lo que llegó.
    return {
      ok: false,
      motivo:
        'No se reconoció ningún producto en ese texto. Revisa que hayas ' +
        'copiado la publicación completa.',
    };
  }

  /* Las fotos se COPIAN, no se enlazan. Un enlace al servidor del portal se cae
     el día que bajen el anuncio o bloqueen el hotlinking, y el síntoma es el
     peor posible: el bot manda la foto, Meta no puede descargarla y el cliente
     se queda esperando una imagen que nunca llega. Además se convierten a JPG,
     que es lo único que Meta acepta sin protestar. */
  let imagen_url = null;
  let imagenes_guardadas = [];

  if (descargar_imagenes && imagenes.length) {
    const aCopiar = imagenes.slice(0, 4);
    const copiadas = await Promise.all(
      aCopiar.map((u, i) =>
        downloadAndConvertToJpgS3(u, `imp-${id_configuracion}-${i}`, 'productos/importados')
          .catch(() => null),
      ),
    );
    imagenes_guardadas = copiadas.filter(Boolean);
    imagen_url = imagenes_guardadas[0] || null;
  }

  const numero = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  /* Lo que va al formulario. Solo se manda lo que este rubro usa: un catálogo
     de dropshipping recibe nombre, descripción, precio y foto —y nada de
     direcciones ni fichas— porque cada campo de más es un campo que alguien
     tiene que mirar y descartar. */
  const borrador = {
    nombre: String(base.nombre).slice(0, 255),
    descripcion: base.descripcion || '',
    precio: numero(base.precio),
    // Sin rubro es un producto: se vende y se envía, no se va a verlo.
    tipo: def?.tipo_item || 'producto',
    galeria_url: base.galeria_url || url || '',
    imagen_url,
    imagenes: imagenes_guardadas,
  };

  if (def?.duracion_sugerida) borrador.duracion = def.duracion_sugerida;

  if (def?.usa_ubicacion) {
    borrador.direccion = base.direccion || '';
    borrador.sector = base.sector || '';
    borrador.ciudad = base.ciudad || '';
    borrador.coordenadas =
      base.latitud && base.longitud ? `${base.latitud}, ${base.longitud}` : '';
  }

  if (def?.campos?.length) {
    borrador.atributos = Object.fromEntries(
      def.campos.map((c) => [c.clave, base[c.clave] || '']),
    );
  }

  return {
    ok: true,
    fuente,
    preset: preset || null,
    uso_ia: usoIA,
    aviso: avisoIA,
    borrador,
  };
}

module.exports = { importarDesdeUrl, construirSchema };
