'use strict';

/* Leer un anuncio publicado en un portal.
   ─────────────────────────────────────────────────────────────
   Cargar un inmueble a mano son quince campos que ya están escritos en el
   anuncio que la corredora publicó hace una semana. Copiarlos de nuevo es el
   trámite que hace que el catálogo nunca esté al día — y un catálogo
   desactualizado es un bot que cotiza lo que ya se vendió.

   La extracción va en cascada, de lo más confiable a lo más frágil:

     1. JSON-LD (`application/ld+json`) — es schema.org, lo pone el portal para
        Google y por eso lo mantiene. Cuando está, es el mejor dato.
     2. El estado embebido del framework (`__NEXT_DATA__`, `__PRELOADED_STATE__`)
        — trae lo que el JSON-LD no: dormitorios, baños, metros, coordenadas.
     3. Meta tags Open Graph — título, descripción e imagen. Siempre están.

   Ninguna de las tres es un contrato: el portal cambia su markup cuando quiere
   y no nos avisa. Por eso esto NO decide nada solo: devuelve un borrador que
   una persona revisa antes de guardar, y arriba de todo esto hay un respaldo
   con IA (importadorCatalogo.service) que lee la página como texto cuando la
   extracción estructurada viene pobre.

   Ese respaldo es lo que hace que el importador no se rompa el día que
   Plusvalía cambie una clase de CSS. */

const axios = require('axios');

/* Se pide como pediría un navegador. Sin esto, varios portales devuelven un
   404 o una página de bloqueo: no es evasión, es que un cliente HTTP sin
   headers no se parece a nada que ellos esperen servir. */
const HEADERS_NAVEGADOR = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'es-EC,es;q=0.9,en;q=0.8',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

async function descargarHtml(url) {
  const res = await axios.get(url, {
    headers: HEADERS_NAVEGADOR,
    timeout: 20000,
    maxRedirects: 5,
    // 5 MB: una página de anuncio pesa mucho menos y así un HTML gigante no
    // se lleva la memoria del proceso por delante.
    maxContentLength: 5 * 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return String(res.data || '');
}

const decodificar = (s) =>
  String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

/* Texto plano de la página, para el respaldo con IA. No es un parser de HTML:
   se sacan script y style —que son la mayor parte del peso y puro ruido— y se
   colapsan las etiquetas. Alcanza de sobra para que un modelo lea un anuncio. */
function aTextoPlano(html) {
  return decodificar(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bloquesJsonLd(html) {
  const salida = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      // Un mismo bloque puede traer un arreglo o un @graph con varias entidades.
      if (Array.isArray(parsed)) salida.push(...parsed);
      else if (Array.isArray(parsed['@graph'])) salida.push(...parsed['@graph']);
      else salida.push(parsed);
    } catch {
      /* un bloque roto no puede tumbar los demás */
    }
  }
  return salida;
}

function estadoEmbebido(html) {
  const patrones = [
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
  ];
  for (const re of patrones) {
    const m = re.exec(html);
    if (!m) continue;
    try {
      return JSON.parse(m[1].trim());
    } catch {
      /* seguimos con el siguiente patrón */
    }
  }
  return null;
}

function metaOg(html, propiedad) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propiedad}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const alterno = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${propiedad}["']`,
    'i',
  );
  const m = re.exec(html) || alterno.exec(html);
  return m ? decodificar(m[1]) : null;
}

/* Recorre un JSON cualquiera buscando las claves que nos interesan. Se hace así
   y no con una ruta fija (`props.pageProps.listing.…`) a propósito: esa ruta es
   exactamente lo que el portal cambia entre despliegues, y una búsqueda por
   nombre de clave sobrevive a que muevan el objeto de lugar. */
function buscarClaves(objeto, claves, profundidadMax = 8) {
  const encontrados = {};
  const visto = new Set();

  const caminar = (nodo, nivel) => {
    if (!nodo || nivel > profundidadMax || typeof nodo !== 'object') return;
    if (visto.has(nodo)) return;
    visto.add(nodo);

    if (Array.isArray(nodo)) {
      for (const hijo of nodo.slice(0, 200)) caminar(hijo, nivel + 1);
      return;
    }

    for (const [k, v] of Object.entries(nodo)) {
      const clave = k.toLowerCase();
      for (const [destino, alias] of Object.entries(claves)) {
        if (encontrados[destino] !== undefined) continue;
        if (!alias.includes(clave)) continue;
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') continue;
        const texto = String(v).trim();
        if (texto && texto !== '0') encontrados[destino] = texto;
      }
      if (v && typeof v === 'object') caminar(v, nivel + 1);
    }
  };

  caminar(objeto, 0);
  return encontrados;
}

/* Claves con las que los portales de la región nombran cada dato. La lista es
   larga porque cada uno usa las suyas y no hay estándar; agregar un portal
   nuevo suele ser agregar un alias acá y nada más. */
const ALIAS = {
  dormitorios: ['bedrooms', 'dormitorios', 'habitaciones', 'numberofrooms', 'rooms'],
  banos: ['bathrooms', 'banos', 'baños', 'numberofbathroomstotal', 'fullbathrooms'],
  parqueaderos: ['parking', 'parkinglots', 'garages', 'parqueaderos', 'estacionamientos'],
  area_construccion: ['coveredarea', 'builtarea', 'areaconstruida', 'floorsize', 'm2covered'],
  area_terreno: ['totalarea', 'landarea', 'areatotal', 'lotsize', 'm2total'],
  precio: ['price', 'precio', 'amount', 'listprice'],
  moneda: ['currency', 'currencyid', 'pricecurrency'],
  latitud: ['latitude', 'lat', 'latitud'],
  longitud: ['longitude', 'lon', 'lng', 'longitud'],
  direccion: ['address', 'streetaddress', 'direccion', 'fulladdress'],
  sector: ['neighborhood', 'barrio', 'sector', 'zone', 'addresslocality'],
  ciudad: ['city', 'ciudad', 'addressregion', 'locality'],
  operacion: ['operationtype', 'operacion', 'transactiontype'],
  tipo_inmueble: ['propertytype', 'tipoinmueble', 'realestatetype'],
  antiguedad: ['age', 'antiguedad', 'yearbuilt'],
};

const soloNumero = (v) => {
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(v || '').replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Lee un anuncio y devuelve un BORRADOR. Nunca guarda nada.
 *
 * @returns {Promise<{ok:boolean, borrador?:object, texto_pagina?:string, fuente?:string, motivo?:string}>}
 */
async function leerAnuncio(url) {
  let html;
  try {
    html = await descargarHtml(url);
  } catch (err) {
    const status = err.response?.status;

    /* 403/429 es protección anti-bot (Cloudflare y parecidos), no un error
       nuestro: Plusvalía la tiene puesta y devuelve el "Just a moment…" a
       cualquier lectura desde un servidor. No se pelea contra eso —se rompería
       cada dos semanas y no corresponde—: el camino es pegar el texto, que
       llega al mismo borrador y nunca falla. El mensaje tiene que decir
       exactamente qué hacer, o el usuario cree que la función está rota. */
    /* El motivo solo dice QUÉ pasó. El qué hacer lo explica la pantalla, que
       para eso cambia a una guía de tres pasos: repetirlo acá dejaba el aviso
       diciendo dos veces lo mismo. */
    return {
      ok: false,
      bloqueado: status === 403 || status === 429,
      motivo:
        status === 403 || status === 429
          ? 'Este portal no permite que lo leamos desde el servidor.'
          : `No se pudo abrir el enlace (${err.message}).`,
    };
  }

  const jsonLd = bloquesJsonLd(html);
  const estado = estadoEmbebido(html);

  const anuncio =
    jsonLd.find((b) => /product|residence|apartment|house|offer|realestate/i.test(String(b?.['@type']))) ||
    jsonLd[0] ||
    null;

  const deEstado = estado ? buscarClaves(estado, ALIAS) : {};
  const deJsonLd = anuncio ? buscarClaves(anuncio, ALIAS) : {};

  // JSON-LD manda sobre el estado embebido: es el que el portal mantiene por SEO.
  const datos = { ...deEstado, ...deJsonLd };

  const titulo =
    decodificar(anuncio?.name) || metaOg(html, 'og:title') || null;
  const descripcion =
    decodificar(anuncio?.description) ||
    metaOg(html, 'og:description') ||
    null;

  /* Imágenes: las del JSON-LD primero (suelen venir en alta) y la de Open Graph
     como respaldo. Se limitan a 12: nadie revisa más que eso en un borrador y
     cada una es una descarga. */
  const imagenes = [];
  const agregar = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(agregar);
    if (typeof v === 'object') return agregar(v.url || v.contentUrl);
    const s = String(v).trim();
    if (/^https?:\/\//i.test(s) && !imagenes.includes(s)) imagenes.push(s);
  };
  agregar(anuncio?.image);
  agregar(metaOg(html, 'og:image'));

  const precio =
    soloNumero(datos.precio) ??
    soloNumero(anuncio?.offers?.price) ??
    soloNumero(metaOg(html, 'product:price:amount'));

  const borrador = {
    nombre: titulo,
    descripcion,
    precio,
    direccion: datos.direccion || null,
    sector: datos.sector || null,
    ciudad: datos.ciudad || null,
    latitud: soloNumero(datos.latitud),
    longitud: soloNumero(datos.longitud),
    galeria_url: url,
    imagenes: imagenes.slice(0, 12),
    atributos: {
      operacion: datos.operacion || null,
      tipo_inmueble: datos.tipo_inmueble || null,
      dormitorios: datos.dormitorios || null,
      banos: datos.banos || null,
      parqueaderos: datos.parqueaderos || null,
      area_construccion: datos.area_construccion || null,
      area_terreno: datos.area_terreno || null,
      antiguedad: datos.antiguedad || null,
    },
  };

  /* Qué tan completo salió. Lo usa el importador para decidir si vale la pena
     gastar una llamada al modelo: con el título, el precio y media ficha ya
     resuelta, no hace falta. */
  const camposClave = [
    borrador.nombre,
    borrador.precio,
    borrador.descripcion,
    borrador.atributos.dormitorios,
    borrador.atributos.area_construccion,
    borrador.sector || borrador.ciudad,
  ];
  const completitud =
    camposClave.filter((v) => v !== null && v !== undefined && v !== '').length /
    camposClave.length;

  return {
    ok: true,
    borrador,
    completitud,
    texto_pagina: aTextoPlano(html).slice(0, 12000),
    fuente: anuncio ? 'json-ld' : estado ? 'estado-embebido' : 'meta-tags',
  };
}

module.exports = { leerAnuncio, aTextoPlano, descargarHtml };
